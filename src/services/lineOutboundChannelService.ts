import { getLineChannelById, getLineChannelByTenantId, type LineProfileRecord } from "./repository";

export type ChannelTokenSource = "profile_channel" | "tenant_active_channel" | "env_fallback";

export type LineChannelSelection = {
  channelAccessToken?: string;
  lineChannelId?: string;
  channelTokenSource: ChannelTokenSource;
};

export class LineChannelNotConnectedError extends Error {
  public readonly lineChannelId?: string;
  public readonly channelTokenSource: ChannelTokenSource;

  constructor(input: { lineChannelId?: string; channelTokenSource: ChannelTokenSource }) {
    super("LINE channel is not connected");
    this.name = "LineChannelNotConnectedError";
    this.lineChannelId = input.lineChannelId;
    this.channelTokenSource = input.channelTokenSource;
  }
}

export function isLineChannelNotConnectedError(error: unknown): error is LineChannelNotConnectedError {
  return error instanceof LineChannelNotConnectedError;
}

function hasUsableChannelAccessToken(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function resolveLineChannelForOutbound(
  tenantId: string,
  mapping: Pick<LineProfileRecord, "line_channel_id">
): Promise<LineChannelSelection> {
  if (mapping.line_channel_id) {
    const profileChannel = await getLineChannelById(mapping.line_channel_id);

    if (profileChannel) {
      if (
        profileChannel.tenant_id !== tenantId ||
        !profileChannel.is_active ||
        !hasUsableChannelAccessToken(profileChannel.channel_access_token)
      ) {
        throw new LineChannelNotConnectedError({
          lineChannelId: profileChannel.id,
          channelTokenSource: "profile_channel"
        });
      }

      return {
        channelAccessToken: profileChannel.channel_access_token,
        lineChannelId: profileChannel.id,
        channelTokenSource: "profile_channel"
      };
    }
  }

  const tenantChannel = await getLineChannelByTenantId(tenantId);

  if (tenantChannel) {
    if (!tenantChannel.is_active || !hasUsableChannelAccessToken(tenantChannel.channel_access_token)) {
      throw new LineChannelNotConnectedError({
        lineChannelId: tenantChannel.id,
        channelTokenSource: "tenant_active_channel"
      });
    }

    return {
      channelAccessToken: tenantChannel.channel_access_token,
      lineChannelId: tenantChannel.id,
      channelTokenSource: "tenant_active_channel"
    };
  }

  return {
    lineChannelId: mapping.line_channel_id ?? undefined,
    channelTokenSource: "env_fallback"
  };
}
