import { logger } from "../config/logger";
import { getSupabase } from "../config/supabase";
import { pushLineTextMessage } from "../integrations/lineClient";
import {
  ensureDefaultTenant,
  type LineProfileRecord,
  saveMessageEvent
} from "./repository";

type WorkflowSendLineStatus = "sent" | "skipped" | "failed";

export type WorkflowSendLineResponse = {
  ok: boolean;
  status: WorkflowSendLineStatus;
  provider: "line";
  lineMessageId: string | null;
  error: string;
};

export type WorkflowSendLineResult = {
  httpStatus: number;
  body: WorkflowSendLineResponse;
};

function getRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildResponse(
  httpStatus: number,
  status: WorkflowSendLineStatus,
  error = "",
  lineMessageId: string | null = null
): WorkflowSendLineResult {
  return {
    httpStatus,
    body: {
      ok: status === "sent",
      status,
      provider: "line",
      lineMessageId,
      error
    }
  };
}

function buildExternalMessageId(workflowId: string | undefined, metaKey: string | undefined): string | undefined {
  if (workflowId) {
    return `workflow:${workflowId}`;
  }

  if (metaKey) {
    return `workflow-action:${metaKey}`;
  }

  return undefined;
}

function buildWorkflowEventPayload(input: {
  locationId?: string;
  contactId?: string;
  workflowId?: string;
  metaKey?: string;
  metaVersion?: string;
  messagePresent: boolean;
}): Record<string, unknown> {
  return {
    source: "ghl_workflow_action",
    locationId: input.locationId ?? null,
    contactId: input.contactId ?? null,
    workflowId: input.workflowId ?? null,
    metaKey: input.metaKey ?? null,
    metaVersion: input.metaVersion ?? null,
    messagePresent: input.messagePresent
  };
}

async function findLineProfileByLocationAndGhlContact(
  locationId: string,
  contactId: string
): Promise<LineProfileRecord | null> {
  const normalizedLocationId = locationId.trim();
  const normalizedContactId = contactId.trim();
  const supabase = getSupabase();
  const { data: tenants, error: tenantsError } = await supabase
    .from("tenants")
    .select("id, location_id, updated_at")
    .eq("location_id", normalizedLocationId)
    .order("updated_at", { ascending: false });

  if (tenantsError) {
    throw new Error(tenantsError.message);
  }

  const tenantIds = (tenants ?? [])
    .map((tenant) => (typeof tenant.id === "string" ? tenant.id : undefined))
    .filter((tenantId): tenantId is string => Boolean(tenantId));

  if (tenantIds.length === 0) {
    logger.info(
      {
        locationId: normalizedLocationId,
        contactId: normalizedContactId,
        tenantCount: 0,
        mappingFound: false
      },
      "GHL workflow LINE mapping lookup completed"
    );

    return null;
  }

  const { data, error } = await supabase
    .from("line_profiles")
    .select("*")
    .in("tenant_id", tenantIds)
    .eq("ghl_contact_id", normalizedContactId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const mapping = data as LineProfileRecord | null;

  logger.info(
    {
      locationId: normalizedLocationId,
      contactId: normalizedContactId,
      tenantCount: tenantIds.length,
      mappingFound: Boolean(mapping),
      foundTenantId: mapping?.tenant_id,
      foundLineUserId: mapping?.line_user_id,
      foundGhlConversationId: mapping?.ghl_conversation_id
    },
    "GHL workflow LINE mapping lookup completed"
  );

  return mapping;
}

export async function processGhlWorkflowSendLine(payload: Record<string, unknown>): Promise<WorkflowSendLineResult> {
  const data = getRecord(payload.data);
  const extras = getRecord(payload.extras);
  const meta = getRecord(payload.meta);

  const message = getString(data.message);
  const locationId = getString(extras.locationId);
  const contactId = getString(extras.contactId);
  const workflowId = getString(extras.workflowId);
  const metaKey = getString(meta.key);
  const metaVersion = getString(meta.version);

  const eventPayload = buildWorkflowEventPayload({
    locationId,
    contactId,
    workflowId,
    metaKey,
    metaVersion,
    messagePresent: Boolean(message)
  });
  const externalMessageId = buildExternalMessageId(workflowId, metaKey);

  if (!message) {
    logger.warn(
      {
        locationId,
        contactId,
        workflowId,
        metaKey
      },
      "Skipped GHL workflow LINE send because message is missing"
    );

    return buildResponse(400, "failed", "Message is required");
  }

  if (!locationId) {
    logger.warn(
      {
        contactId,
        workflowId,
        metaKey
      },
      "Skipped GHL workflow LINE send because locationId is missing"
    );

    return buildResponse(400, "failed", "locationId is required");
  }

  if (!contactId) {
    try {
      const tenantId = await ensureDefaultTenant();

      await saveMessageEvent({
        tenantId,
        provider: "line",
        direction: "outbound",
        externalMessageId,
        payload,
        status: "skipped",
        errorMessage: "No LINE mapping found for contact",
        requestPayload: eventPayload
      });
    } catch (error) {
      logger.warn(
        {
          locationId,
          workflowId,
          metaKey,
          errorMessage: error instanceof Error ? error.message : "Unknown Supabase error"
        },
        "Failed to save skipped workflow LINE send event for missing contactId"
      );
    }

    logger.warn(
      {
        locationId,
        workflowId,
        metaKey
      },
      "Skipped GHL workflow LINE send because contactId is missing"
    );

    return buildResponse(200, "skipped", "No LINE mapping found for contact");
  }

  const mapping = await findLineProfileByLocationAndGhlContact(locationId, contactId);

  if (!mapping) {
    const tenantId = await ensureDefaultTenant();

    await saveMessageEvent({
      tenantId,
      provider: "line",
      direction: "outbound",
      externalMessageId,
      payload,
      status: "skipped",
      errorMessage: "No LINE mapping found for contact",
      requestPayload: eventPayload
    });

    logger.warn(
      {
        locationId,
        contactId,
        workflowId,
        metaKey
      },
      "Skipped GHL workflow LINE send because no LINE mapping exists"
    );

    return buildResponse(200, "skipped", "No LINE mapping found for contact");
  }

  try {
    const lineResult = await pushLineTextMessage(mapping.line_user_id, message);

    await saveMessageEvent({
      tenantId: mapping.tenant_id,
      provider: "line",
      direction: "outbound",
      externalMessageId,
      lineUserId: mapping.line_user_id,
      ghlConversationId: mapping.ghl_conversation_id ?? undefined,
      payload,
      status: "sent",
      requestPayload: eventPayload
    });

    logger.info(
      {
        locationId,
        contactId,
        workflowId,
        metaKey,
        lineUserId: mapping.line_user_id,
        lineMessageId: lineResult.messageId
      },
      "GHL workflow LINE message sent"
    );

    return buildResponse(200, "sent", "", lineResult.messageId ?? null);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown LINE send error";

    await saveMessageEvent({
      tenantId: mapping.tenant_id,
      provider: "line",
      direction: "outbound",
      externalMessageId,
      lineUserId: mapping.line_user_id,
      ghlConversationId: mapping.ghl_conversation_id ?? undefined,
      payload,
      status: "failed",
      errorMessage,
      requestPayload: eventPayload
    });

    logger.error(
      {
        locationId,
        contactId,
        workflowId,
        metaKey,
        lineUserId: mapping.line_user_id,
        errorMessage
      },
      "Failed to send GHL workflow LINE message"
    );

    return buildResponse(200, "failed", errorMessage);
  }
}
