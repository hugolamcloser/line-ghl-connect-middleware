import { env, requireEnvValue } from "../config/env";
import { logger } from "../config/logger";
import { forceRefreshGhlAuthContext, getGhlAuthContext, type GhlAuthContext } from "../services/ghlOAuthService";
import { redactSecrets, redactSensitiveText } from "../utils/redaction";

type AuthMode = "oauth" | "private_integration";
type FailureClass = "A" | "B" | "C" | "D" | "E" | "F" | "payload_validation_reached" | "none" | "unknown";

type MatrixResult = {
  auth_mode: AuthMode;
  attempted: boolean;
  endpoint: string;
  method: string;
  provider_id_used: string;
  location_id: string;
  inbound_message_type: string;
  statusCode?: number;
  canonicalCode?: string;
  message?: string;
  responseBody?: unknown;
  diagnosis?: string;
  likely_failure_class?: FailureClass;
  error?: string;
  skipped_reason?: string;
};

const providerNoAccessCanonicalCode = "CONVERSATIONS_MSG_PROVIDER_NO_ACCESS";

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getNestedString(payload: unknown, ...path: string[]): string | undefined {
  let current = payload;

  for (const key of path) {
    const record = getRecord(current);

    if (!record || !(key in record)) {
      return undefined;
    }

    current = record[key];
  }

  return getString(current);
}

function parseResponseBody(responseText: string): unknown {
  if (!responseText) {
    return undefined;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

function getGhlErrorDetails(responseBody: unknown): { canonicalCode?: string; message?: string } {
  return {
    canonicalCode:
      getNestedString(responseBody, "canonicalCode") ??
      getNestedString(responseBody, "error", "canonicalCode") ??
      getNestedString(responseBody, "meta", "canonicalCode"),
    message:
      getNestedString(responseBody, "message") ??
      getNestedString(responseBody, "error", "message") ??
      getNestedString(responseBody, "msg")
  };
}

function idsEqual(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left?.trim() && right?.trim() && left.trim() === right.trim());
}

function getProviderIdEqualsOAuthClientId(): boolean {
  return idsEqual(env.GHL_CUSTOM_PROVIDER_ID, env.GHL_OAUTH_CLIENT_ID);
}

function getConfiguredConversationProviderId(): string {
  return requireEnvValue("GHL_CUSTOM_PROVIDER_ID", env.GHL_CUSTOM_PROVIDER_ID);
}

function getConfiguredInboundMessageType(): string {
  const configuredType = env.GHL_INBOUND_MESSAGE_TYPE.trim() || "SMS";
  const normalizedType = configuredType.toLowerCase();

  if (normalizedType === "sms") {
    return "SMS";
  }

  if (normalizedType === "email") {
    return "Email";
  }

  if (normalizedType === "custom") {
    return "Custom";
  }

  if (normalizedType === "call") {
    return "Call";
  }

  return configuredType;
}

function buildMatrixProbePayload(conversationProviderId: string, locationId: string) {
  return {
    locationId,
    contactId: "debug-provider-access-test-contact",
    conversationProviderId,
    externalConversationId: `debug-auth-matrix:${locationId}:${conversationProviderId}`,
    externalMessageId: `debug-auth-matrix:${Date.now()}`,
    type: getConfiguredInboundMessageType(),
    message: "Auth matrix probe. This should fail before creating a real message.",
    attachments: []
  };
}

function diagnoseResponse(input: {
  ok: boolean;
  statusCode: number;
  canonicalCode?: string;
  message?: string;
  responseBody?: unknown;
}): { diagnosis: string; likelyFailureClass: FailureClass } {
  const message = input.message?.toLowerCase() ?? "";
  const bodyText =
    typeof input.responseBody === "string" ? input.responseBody.toLowerCase() : JSON.stringify(input.responseBody ?? {}).toLowerCase();

  if (input.ok) {
    return {
      likelyFailureClass: "none",
      diagnosis: "HighLevel accepted the inbound message request with this auth mode."
    };
  }

  if (input.statusCode === 400) {
    return {
      likelyFailureClass: "payload_validation_reached",
      diagnosis:
        "HighLevel reached request validation. This usually means endpoint, auth mode, and provider binding were accepted for this probe."
    };
  }

  if (input.statusCode === 401 && message.includes("authclass")) {
    return {
      likelyFailureClass: "B",
      diagnosis:
        "Likely B: wrong auth class, or the Marketplace Conversation Provider module is not permitted to call this inbound-message API for the installed app/location."
    };
  }

  if (input.canonicalCode === providerNoAccessCanonicalCode) {
    return {
      likelyFailureClass: "C",
      diagnosis:
        "Likely C or D: the configured conversationProviderId is not accessible for this installed location, or the location provider binding is missing/stale."
    };
  }

  if (input.statusCode === 401 || input.statusCode === 403) {
    return {
      likelyFailureClass: "E",
      diagnosis:
        "Likely E: missing module permission, missing scope, stale app install, or provider setup not connected to this Marketplace app version."
    };
  }

  if (input.statusCode === 404) {
    return {
      likelyFailureClass: "A",
      diagnosis:
        "Likely A or F: the endpoint path is wrong for this API version/account, or unsupported for the current app/provider configuration."
    };
  }

  if (bodyText.includes("conversationprovider") && bodyText.includes("access")) {
    return {
      likelyFailureClass: "D",
      diagnosis:
        "Likely D: HighLevel recognized the provider field but rejected access to the installed provider binding for this location."
    };
  }

  return {
    likelyFailureClass: "unknown",
    diagnosis:
      "HighLevel returned a response that does not cleanly map to endpoint, auth class, provider id, provider binding, module configuration, or unsupported-path failures."
  };
}

async function performGhlRequest(
  path: string,
  init: RequestInit | undefined,
  auth: GhlAuthContext
): Promise<Response> {
  return fetch(`${env.GHL_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Version: requireEnvValue("GHL_API_VERSION", env.GHL_API_VERSION),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {})
    }
  });
}

function isAuthClassFailure(result: MatrixResult): boolean {
  return result.statusCode === 401 && Boolean(result.message?.toLowerCase().includes("authclass"));
}

function isPayloadValidationOrSuccess(result: MatrixResult): boolean {
  return (
    Boolean(result.statusCode && result.statusCode >= 200 && result.statusCode < 300) ||
    result.statusCode === 400 ||
    result.likely_failure_class === "payload_validation_reached"
  );
}

function getRecommendation(results: MatrixResult[]): {
  recommended_send_auth_mode?: AuthMode;
  recommended_action?: string;
} {
  const oauthResult = results.find((result) => result.auth_mode === "oauth");
  const privateResult = results.find((result) => result.auth_mode === "private_integration");

  if (oauthResult && privateResult?.attempted && isAuthClassFailure(oauthResult) && isPayloadValidationOrSuccess(privateResult)) {
    return {
      recommended_action:
        "Private Integration auth reached HighLevel request validation while Marketplace OAuth was rejected by authClass. Production sending remains OAuth-only; use this result to investigate the Marketplace app install, provider binding, or OAuth authClass with HighLevel support."
    };
  }

  if (oauthResult?.statusCode === 401 && privateResult?.statusCode === 401) {
    return {
      recommended_action:
        "verify HighLevel Marketplace Conversation Provider module/app install/provider binding with GHL support"
    };
  }

  if (!privateResult?.attempted) {
    return {
      recommended_action:
        "OAuth was tested, but Private Integration auth was skipped because GHL_PRIVATE_INTEGRATION_TOKEN is missing."
    };
  }

  return {
    recommended_action:
      "Compare each auth mode statusCode, canonicalCode, message, and redacted responseBody to identify whether the blocker is auth class, provider binding, endpoint access, or payload validation."
  };
}

async function runProbe(input: {
  auth: GhlAuthContext;
  endpoint: string;
  method: string;
  payload: ReturnType<typeof buildMatrixProbePayload>;
  conversationProviderId: string;
  locationId: string;
}): Promise<MatrixResult> {
  const { auth, endpoint, method, payload, conversationProviderId, locationId } = input;

  try {
    let resolvedAuth = auth;
    let response = await performGhlRequest(endpoint, { method, body: JSON.stringify(payload) }, resolvedAuth);

    if (response.status === 401 && resolvedAuth.mode === "oauth") {
      logger.warn(
        {
          method,
          endpoint,
          authMode: resolvedAuth.mode,
          conversationProviderId,
          locationId,
          inboundMessageType: payload.type,
          statusCode: response.status
        },
        "HighLevel auth matrix OAuth probe returned 401; refreshing token and retrying once"
      );

      resolvedAuth = await forceRefreshGhlAuthContext(locationId);
      response = await performGhlRequest(endpoint, { method, body: JSON.stringify(payload) }, resolvedAuth);
    }

    const responseText = redactSensitiveText(await response.text());
    const responseBody = redactSecrets(parseResponseBody(responseText));
    const { canonicalCode, message } = getGhlErrorDetails(responseBody);
    const diagnosis = diagnoseResponse({
      ok: response.ok,
      statusCode: response.status,
      canonicalCode,
      message,
      responseBody
    });

    logger.info(
      {
        method,
        endpoint,
        authMode: resolvedAuth.mode,
        conversationProviderId,
        providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
        locationId,
        inboundMessageType: payload.type,
        requestBody: redactSecrets(payload),
        statusCode: response.status,
        canonicalCode,
        message,
        responseBody,
        diagnosis
      },
      "HighLevel inbound message auth matrix probe completed"
    );

    return {
      auth_mode: resolvedAuth.mode,
      attempted: true,
      endpoint,
      method,
      provider_id_used: conversationProviderId,
      location_id: locationId,
      inbound_message_type: payload.type,
      statusCode: response.status,
      canonicalCode,
      message,
      responseBody,
      diagnosis: diagnosis.diagnosis,
      likely_failure_class: diagnosis.likelyFailureClass
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(
      {
        method,
        endpoint,
        authMode: auth.mode,
        conversationProviderId,
        providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
        locationId,
        inboundMessageType: payload.type,
        requestBody: redactSecrets(payload),
        error: errorMessage
      },
      "HighLevel inbound message auth matrix probe failed before receiving a response"
    );

    return {
      auth_mode: auth.mode,
      attempted: true,
      endpoint,
      method,
      provider_id_used: conversationProviderId,
      location_id: locationId,
      inbound_message_type: payload.type,
      diagnosis:
        "This auth-mode probe failed before receiving a HighLevel HTTP response. Check server logs for token lookup, network, or configuration errors.",
      likely_failure_class: "unknown",
      error: errorMessage
    };
  }
}

export async function testGhlInboundMessageAuthMatrix(): Promise<{
  endpoint_path: string;
  method: string;
  provider_id_used: string;
  provider_id_equals_oauth_client_id: boolean;
  location_id: string;
  inbound_message_type: string;
  request_payload: unknown;
  results: MatrixResult[];
  recommended_send_auth_mode?: AuthMode;
  recommended_action?: string;
}> {
  const locationId = requireEnvValue("GHL_LOCATION_ID", env.GHL_LOCATION_ID);
  const conversationProviderId = getConfiguredConversationProviderId();
  const endpoint = "/conversations/messages/inbound";
  const method = "POST";
  const payload = buildMatrixProbePayload(conversationProviderId, locationId);
  const results: MatrixResult[] = [];

  logger.info(
    {
      method,
      endpoint,
      conversationProviderId,
      providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
      locationId,
      inboundMessageType: payload.type,
      requestBody: redactSecrets(payload),
      privateIntegrationTokenPresent: Boolean(env.GHL_PRIVATE_INTEGRATION_TOKEN.trim())
    },
    "Testing HighLevel inbound message auth matrix"
  );

  try {
    const oauthAuth = await getGhlAuthContext(locationId, { allowPrivateFallback: false });
    results.push(
      await runProbe({
        auth: oauthAuth,
        endpoint,
        method,
        payload,
        conversationProviderId,
        locationId
      })
    );
  } catch (error) {
    results.push({
      auth_mode: "oauth",
      attempted: false,
      endpoint,
      method,
      provider_id_used: conversationProviderId,
      location_id: locationId,
      inbound_message_type: payload.type,
      diagnosis:
        "Stored Marketplace OAuth token could not be loaded before the probe. Confirm /debug/oauth-status token_present is true.",
      likely_failure_class: "unknown",
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const privateIntegrationToken = env.GHL_PRIVATE_INTEGRATION_TOKEN.trim();

  if (privateIntegrationToken) {
    results.push(
      await runProbe({
        auth: {
          mode: "private_integration",
          accessToken: privateIntegrationToken,
          locationId
        },
        endpoint,
        method,
        payload,
        conversationProviderId,
        locationId
      })
    );
  } else {
    results.push({
      auth_mode: "private_integration",
      attempted: false,
      endpoint,
      method,
      provider_id_used: conversationProviderId,
      location_id: locationId,
      inbound_message_type: payload.type,
      skipped_reason: "GHL_PRIVATE_INTEGRATION_TOKEN is missing",
      diagnosis: "Private Integration auth was not tested because GHL_PRIVATE_INTEGRATION_TOKEN is not configured."
    });
  }

  const recommendation = getRecommendation(results);

  logger.info(
    {
      method,
      endpoint,
      conversationProviderId,
      providerIdEqualsOAuthClientId: getProviderIdEqualsOAuthClientId(),
      locationId,
      inboundMessageType: payload.type,
      requestBody: redactSecrets(payload),
      results,
      recommendation
    },
    "HighLevel inbound message auth matrix completed"
  );

  return {
    endpoint_path: endpoint,
    method,
    provider_id_used: conversationProviderId,
    provider_id_equals_oauth_client_id: getProviderIdEqualsOAuthClientId(),
    location_id: locationId,
    inbound_message_type: payload.type,
    request_payload: redactSecrets(payload),
    results,
    ...recommendation
  };
}
