export type GhlCreateContactInput = {
  lineUserId: string;
  locationId?: string;
  displayName?: string;
  pictureUrl?: string;
};

export type GhlContactResponse = {
  id: string;
  raw: Record<string, unknown>;
};

export type GhlInboundMessageInput = {
  tenantId?: string;
  contactId: string;
  locationId?: string;
  conversationProviderId?: string;
  conversationId?: string;
  externalConversationId: string;
  externalMessageId: string;
  message: string;
  attachments?: string[];
};

export type GhlInboundMessageResponse = {
  id?: string;
  messageId?: string;
  conversationId?: string;
  contactId?: string;
  [key: string]: unknown;
};

export type NormalizedGhlOutboundMessage = {
  contactId?: string;
  locationId?: string;
  conversationId?: string;
  messageId?: string;
  conversationProviderId?: string;
  message?: string;
  attachments: unknown[];
  raw: Record<string, unknown>;
};
