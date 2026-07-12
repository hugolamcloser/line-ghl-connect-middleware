# LINE to GoHighLevel Conversation Middleware

Node.js, Express, TypeScript, and Supabase middleware for syncing LINE Official Account conversations with GoHighLevel Conversations through a custom Conversation Provider.

The service accepts inbound LINE webhooks, validates the `x-line-signature` HMAC, saves LINE profiles in Supabase, creates or reuses mapped GHL contacts, forwards inbound messages into HighLevel, receives outbound provider webhooks from HighLevel, and pushes replies back to LINE.

## What Is Included

- Express API with typed route handlers.
- LINE webhook signature verification using the raw request body.
- LINE profile lookup and push message support.
- Automatic GHL contact creation for new LINE users.
- HighLevel API client for inbound custom provider messages.
- Outbound HighLevel webhook handler for replies back to LINE.
- Supabase migration for tenants, LINE profile mappings, message audit logs, and raw webhook audit storage.
- Admin endpoint for linking a LINE user to a GHL contact/conversation.
- Dockerfile and production build scripts.

## Project Structure

```text
src/
  app.ts                       Express app assembly
  server.ts                    HTTP server entrypoint
  config/                      Environment, logger, Supabase client
  integrations/                LINE and HighLevel API clients
  middleware/                  JSON/raw body, errors, shared-secret auth
  routes/                      Health, LINE webhook, GHL webhook, admin routes
  services/                    Sync logic and Supabase repository helpers
  types/                       LINE, GHL, and HTTP types
supabase/
  migrations/                  SQL migration files
```

## Requirements

- Node.js 22 or newer.
- Supabase project.
- LINE Official Account Messaging API channel.
- HighLevel Marketplace app OAuth credentials.
- HighLevel custom Conversation Provider configured for the target location.

## Environment Setup

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Important production values:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: Supabase backend credentials. Use the service role key only on the server.
- `LINE_CHANNEL_SECRET`: Legacy/default fallback for LINE webhook signatures. Connected multi-tenant LINE webhooks use the tenant's `line_channels.channel_secret`.
- `LINE_CHANNEL_ACCESS_TOKEN`: Legacy/default fallback for LINE profile and push APIs. Connected multi-tenant runtime sends use the tenant's `line_channels.channel_access_token`.
- `GHL_LOCATION_ID`: Legacy/default diagnostics location only. It must not be used to identify a new OAuth installation.
- `GHL_CUSTOM_PROVIDER_ID`: Your HighLevel custom Conversation Provider ID.
- `GHL_INBOUND_MESSAGE_TYPE`: HighLevel inbound message `type`. The confirmed production LINE setup uses `Custom`.
- `GHL_SEND_CONVERSATION_PROVIDER_ID`: Set to `true` for the confirmed production LINE provider setup so `conversationProviderId` is sent to HighLevel.
- `GHL_LOCATION_API_AUTH_MODE`: Auth mode for LINE inbound location-level writes: contact create, contact fetch/update, tags, and optional custom fields. The confirmed production setup uses `private_integration`.
- `GHL_INBOUND_SEND_AUTH_MODE`: Legacy diagnostic/config visibility for `POST /conversations/messages/inbound`. The real inbound send path is forced to the stored location OAuth token.
- `GHL_OAUTH_CLIENT_ID`, `GHL_OAUTH_CLIENT_SECRET`, and `GHL_OAUTH_REDIRECT_URI`: HighLevel Marketplace app OAuth settings. Production LINE to GHL forwarding uses the installed location OAuth token stored in Supabase.
- `GHL_MARKETPLACE_APP_ID`: HighLevel Marketplace App ID. Required to correlate signed AppInstall events with short-lived Company OAuth sessions before creating exact location-scoped tokens.
- `GHL_LINE_USER_ID_FIELD_ID`: Optional GHL custom field ID for storing the LINE user ID.
- `GHL_LINE_DISPLAY_NAME_FIELD_ID`: Optional GHL custom field ID for storing the LINE display name.
- `GHL_PRIVATE_INTEGRATION_TOKEN`: Required for this production setup because `GHL_LOCATION_API_AUTH_MODE=private_integration`.
- `GHL_CUSTOM_PROVIDER_SECRET`: Recommended shared secret for outbound webhooks from HighLevel.
- `WEBHOOK_SHARED_SECRET`: Required for admin routes and protected production debug endpoints.

## Production Required Variables

Use these values for the confirmed production LINE to GHL setup:

```text
NODE_ENV=production
LOG_LEVEL=info
PUBLIC_BASE_URL=https://win-crm.up.railway.app
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
GHL_API_BASE_URL=https://services.leadconnectorhq.com
GHL_API_VERSION=2021-07-28
GHL_LOCATION_ID=...
GHL_CUSTOM_PROVIDER_ID=...
GHL_OAUTH_CLIENT_ID=...
GHL_OAUTH_CLIENT_SECRET=...
GHL_OAUTH_REDIRECT_URI=https://win-crm.up.railway.app/oauth/callback
GHL_OAUTH_TOKEN_URL=https://services.leadconnectorhq.com/oauth/token
GHL_MARKETPLACE_APP_ID=...
GHL_INBOUND_MESSAGE_TYPE=Custom
GHL_SEND_CONVERSATION_PROVIDER_ID=true
GHL_INBOUND_SEND_AUTH_MODE=oauth
GHL_LOCATION_API_AUTH_MODE=private_integration
GHL_PRIVATE_INTEGRATION_TOKEN=...
GHL_CUSTOM_PROVIDER_SECRET=...
WEBHOOK_SHARED_SECRET=...
```

Optional variables:

- `PORT`: Railway sets this automatically. Local default is `3000`.
- `GHL_LINE_USER_ID_FIELD_ID`: Optional GHL custom field for the LINE user ID.
- `GHL_LINE_DISPLAY_NAME_FIELD_ID`: Optional GHL custom field for the LINE display name.

OAuth onboarding is multi-tenant and zero-touch after the global Railway configuration is set. Direct Location OAuth responses are stored against the returned `locationId`. Company OAuth responses are held as short-lived server-only onboarding sessions and correlated with the exact location from HighLevel's signed AppInstall webhook. The middleware then calls `/oauth/location-token`, ensures that location's tenant, and upserts only that location's `ghl_oauth_tokens` row. It never uses `GHL_LOCATION_ID`, historical installed-location lists, or another tenant's token to guess a new installation.

Deprecated, testing-only, or migration-only variables:

- `GHL_ALLOW_PRIVATE_TOKEN_FALLBACK`: Deprecated fallback path. Keep `false` in production.
- `GHL_INBOUND_SEND_AUTH_MODE=private_integration`: Deprecated. Real inbound forwarding ignores this value and uses OAuth for `POST /conversations/messages/inbound`.
- `GHL_INBOUND_MESSAGE_TYPE=SMS`: Old testing value. The confirmed production value is `Custom`.
- `GHL_SEND_CONVERSATION_PROVIDER_ID=false`: Old testing value. The confirmed production value is `true`.

Never expose `SUPABASE_SERVICE_ROLE_KEY`, LINE secrets, OAuth client secret, OAuth access/refresh tokens, private integration token, provider secret, or webhook shared secret.

## Do Not Change Unless Migrating

These settings are part of the confirmed working production wiring. Keep them unchanged unless you are intentionally migrating to a new LINE channel, GHL location, Marketplace app, or Conversation Provider:

- `GHL_CUSTOM_PROVIDER_ID`: Must remain the active GHL Conversation Provider ID for this location.
- `GHL_INBOUND_MESSAGE_TYPE=Custom`: The working inbound message payload uses HighLevel type `Custom`.
- `GHL_SEND_CONVERSATION_PROVIDER_ID=true`: The working inbound message payload includes `conversationProviderId`.
- `GHL_INBOUND_SEND_AUTH_MODE=oauth`: The working inbound message send uses the installed Location OAuth token. The runtime enforces OAuth for this endpoint.
- `GHL_LOCATION_API_AUTH_MODE=private_integration`: The working contact create/update/tag/custom-field path uses the Private Integration token.
- LINE webhook URL: `https://win-crm.up.railway.app/webhooks/line/inbound`
- GHL Conversation Provider Delivery URL: `https://win-crm.up.railway.app/webhooks/ghl/line/outbound`
- GHL AppInstall webhook Delivery URL: `https://win-crm.up.railway.app/webhooks/ghl/app-install`

## Future Custom Domain Migration

`api.win-crm.ai` is not active for the current production setup yet. The current working production base URL is:

```text
https://win-crm.up.railway.app
```

Only switch to `api.win-crm.ai` after the custom domain is connected in Railway and tested end to end. When switching, update these values and external settings together:

- `PUBLIC_BASE_URL`
- `GHL_OAUTH_REDIRECT_URI`
- GHL Marketplace OAuth callback URL
- LINE Developers webhook URL
- GHL Conversation Provider Delivery URL

## Production Smoke Test Checklist

After deploy, confirm the live system still passes these checks:

1. Send a LINE text message and confirm it appears in the GHL conversation.
2. Reply from GHL and confirm the text arrives in LINE.
3. Delete the mapped GHL contact, send another LINE message, and confirm a replacement contact is created.
4. Check the latest Supabase `message_events` rows show `success` or `sent` with `error_message` as `null`.
5. Check the duplicate/debug `line_profiles` query returns no rows.

## Supabase Setup

Apply migrations in order:

1. `supabase/migrations/202607020001_initial_schema.sql`
2. `supabase/migrations/202607030001_ghl_oauth_tokens.sql`
3. `supabase/migrations/202607060001_line_profiles_unique_line_user.sql`
4. `supabase/migrations/202607080001_line_channels.sql`
5. `supabase/migrations/202607110001_ghl_oauth_onboarding.sql`

Using the Supabase CLI:

```bash
supabase db push
```

Or paste each SQL migration into the Supabase SQL editor and run them one at a time.

Seeing `Success. No rows returned` after running the migration is normal because the SQL creates schema objects and does not return table rows. RLS can be enabled on the tables; this backend uses `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS for server-side operations. Do not expose `SUPABASE_SERVICE_ROLE_KEY` publicly, in browser code, or in mobile apps.

The OAuth migrations create `ghl_oauth_tokens` for location-scoped Marketplace tokens plus `ghl_oauth_onboarding_sessions` and `ghl_pending_app_installs` for durable AppInstall correlation. Company credentials are server-only, capped to a short onboarding lifetime, and never stored as location tokens. Never expose token values from Supabase.

## Install And Build

```bash
npm install
npm run build
```

Run locally:

```bash
npm run dev
```

Run the compiled service:

```bash
npm start
```

## Webhook URLs

Assuming `PUBLIC_BASE_URL=https://win-crm.up.railway.app`:

- LINE webhook URL: `https://win-crm.up.railway.app/webhooks/line/inbound`
- HighLevel outbound provider webhook URL: `https://win-crm.up.railway.app/webhooks/ghl/line/outbound`
- HighLevel Marketplace OAuth callback URL: `https://win-crm.up.railway.app/oauth/callback`
- HighLevel AppInstall webhook Delivery URL: `https://win-crm.up.railway.app/webhooks/ghl/app-install`
- Health check: `https://win-crm.up.railway.app/health`
- Safe environment check: `https://win-crm.up.railway.app/debug/env-check`
- OAuth token status: `https://win-crm.up.railway.app/debug/oauth-status`
- OAuth callback config: `https://win-crm.up.railway.app/debug/oauth-callback-config`
- OAuth token test: `https://win-crm.up.railway.app/debug/ghl-token-test`
- Provider config check: `https://win-crm.up.railway.app/debug/provider-config`
- Provider access test: `https://win-crm.up.railway.app/debug/ghl-provider-test`
- Inbound message endpoint test: `https://win-crm.up.railway.app/debug/ghl-inbound-message-endpoint-test`
- Inbound send auth config: `https://win-crm.up.railway.app/debug/inbound-send-auth-config`
- Configured inbound send auth test: `https://win-crm.up.railway.app/debug/ghl-inbound-send-auth-test`
- Contact auth test: `https://win-crm.up.railway.app/debug/ghl-contact-auth-test`
- Inbound auth matrix test: `https://win-crm.up.railway.app/debug/ghl-inbound-message-auth-matrix-test`

Protected support-only diagnostics:

- Inbound payload matrix test: `https://win-crm.up.railway.app/debug/ghl-inbound-payload-matrix`
- Token install summary: `https://win-crm.up.railway.app/debug/ghl-token-install-summary`

In production, these protected diagnostics require `WEBHOOK_SHARED_SECRET` in `x-webhook-secret` or `Authorization: Bearer ...`. The payload matrix can create diagnostic messages in GHL if a payload variant succeeds, so use these only during support or migration work.

The original route names still work:

- `POST /webhooks/line`
- `POST /webhooks/ghl/outbound`

## LINE Configuration

For connected multi-tenant customers, LINE credentials are entered through the LINE custom page and stored in `line_channels` for that tenant. The global LINE environment variables are legacy/default fallback values only.

1. Install the HighLevel app into the customer's subaccount.
2. Open the LINE custom page for that tenant.
3. Connect the customer's LINE Official Account there. The middleware stores that tenant's channel secret and access token in `line_channels`.
4. Use the tenant-specific webhook URL shown by the custom page.
5. Enable webhooks in LINE.
6. Disable auto-reply settings if HighLevel should own replies.

Only use `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, and `/webhooks/line/inbound` for the legacy/default route or support diagnostics.

LINE signatures are verified against the exact raw UTF-8 body, so do not put middleware or proxies in front of this service that rewrite JSON bodies before they reach Express.

## HighLevel Configuration

1. Create or open the HighLevel Marketplace app for this middleware.
2. Set the Marketplace app OAuth callback URL to `https://win-crm.up.railway.app/oauth/callback`.
3. Add the Marketplace app client ID and client secret to Railway as `GHL_OAUTH_CLIENT_ID` and `GHL_OAUTH_CLIENT_SECRET`.
4. Add the Marketplace App ID to Railway as `GHL_MARKETPLACE_APP_ID`. This is not the OAuth client ID.
5. Configure a custom Conversation Provider for the app/location.
6. Put the actual custom Conversation Provider ID into `GHL_CUSTOM_PROVIDER_ID`. This is not the Marketplace OAuth client ID.
7. For the confirmed production LINE provider, set `GHL_INBOUND_MESSAGE_TYPE=Custom` and `GHL_SEND_CONVERSATION_PROVIDER_ID=true`.
8. Set the provider Delivery URL to `https://win-crm.up.railway.app/webhooks/ghl/line/outbound`.
9. If the provider supports a custom header or secret field, set it to `GHL_CUSTOM_PROVIDER_SECRET`.
10. Subscribe the Marketplace app's `AppInstall` event to `https://win-crm.up.railway.app/webhooks/ghl/app-install`.
11. Install the Marketplace app into any target GHL location. The OAuth callback and signed AppInstall event can arrive in either order; the middleware correlates them by app/company and creates a token only for the exact event `locationId`.
12. Open `/debug/provider-config`; if `provider_id_equals_oauth_client_id` is `true`, `GHL_CUSTOM_PROVIDER_ID` is almost certainly wrong.
13. For normal production checks, use the smoke test below. Keep the deeper GHL provider/debug endpoints for support or migration work only.

The inbound message client posts to:

```text
POST /conversations/messages/inbound
```

with the configured `Version` header. The middleware uses the stored Marketplace OAuth access token for the location. If the OAuth access token is expired or close to expiry, the middleware refreshes it and retries a 401 once. `GHL_LOCATION_API_AUTH_MODE` controls LINE inbound contact create/update/tag/custom-field calls. `GHL_INBOUND_SEND_AUTH_MODE` is retained for diagnostics/backward compatibility, but real `POST /conversations/messages/inbound` forwarding is forced to OAuth because this endpoint rejects the private integration auth class. OAuth install, OAuth callback, and OAuth refresh/storage stay on the OAuth path.

For the confirmed production LINE provider, the payload uses `type: "Custom"` and includes `conversationProviderId`. Use `GHL_INBOUND_MESSAGE_TYPE` only to match the provider type configured in HighLevel.

If `/debug/oauth-status` shows `token_present: true` and `refresh_token_present: true`, the Marketplace OAuth install/token storage is working. If message forwarding then fails with `CONVERSATIONS_MSG_PROVIDER_NO_ACCESS`, the configured `GHL_CUSTOM_PROVIDER_ID` is wrong, not installed for this location, or not connected to the currently installed Marketplace app version.

If HighLevel returns `This authClass type is not allowed to access this scope`, the OAuth token can exist and still be rejected by the inbound-message API. Check that the Marketplace app version installed in the location includes the Conversation Provider module, that the provider was created under that same app/version, that the location has the provider installed under Settings > Conversation Providers, and that `GHL_INBOUND_MESSAGE_TYPE` matches the provider type.

If support asks for deeper diagnostics, `/debug/ghl-inbound-message-auth-matrix-test` can compare OAuth and Private Integration behavior without changing production behavior. Real inbound forwarding remains forced to OAuth for this endpoint.

The Conversation Provider Delivery URL is only for GHL to middleware outbound messages. LINE inbound messages come from the LINE webhook and are then written into GHL through the LeadConnector API using `GHL_LOCATION_API_AUTH_MODE` for contact writes and the stored location OAuth token for `POST /conversations/messages/inbound`. The separate signed AppInstall webhook is required for exact Company OAuth onboarding correlation.

## Mapping A LINE User To A GHL Contact

Inbound LINE events create or update a `line_profiles` row. If that LINE user is already linked to a GHL contact, the message is forwarded to that contact. If no mapping exists yet, the middleware creates a new GHL contact using the LINE display name, saves the `line_user_id` to `ghl_contact_id` mapping in Supabase, then forwards the same inbound LINE message into GHL.

Every LINE-backed contact is created or updated with these tags:

- `line`
- `line:{LINE_USER_ID}`

For example: `line:U93ebe957edac218bfa9b204bc8060446`. The contact source stays `LINE Official Account` when the GHL API accepts that field. Optional LINE custom fields are updated when `GHL_LINE_USER_ID_FIELD_ID` and `GHL_LINE_DISPLAY_NAME_FIELD_ID` are configured.

The admin endpoint remains available as an override tool. Use it when you want to attach a LINE user to an existing GHL contact or conversation:

```bash
curl -X POST https://win-crm.up.railway.app/admin/mappings \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SHARED_SECRET" \
  -d '{
    "lineUserId": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "ghlContactId": "highlevel-contact-id",
    "ghlConversationId": "optional-existing-conversation-id"
  }'
```

Future LINE messages from that user will be forwarded to the linked GHL contact. Future GHL outbound webhooks for that contact or conversation will be pushed back to LINE.

## API Reference

### `GET /health`

Returns service health.

### `GET /debug/env-check`

Returns whether required environment variables are `present` or `missing`. Secret values are never returned.

### `GET /debug/recent-events`

Returns the latest 10 `line_profiles`, latest 10 `message_events`, and latest 10 `webhook_events` rows. Secret values are redacted. `message_events` includes sync status, `error_message`, GHL status code, GHL response body, and redacted request payload when available. Real LINE text inbound sends now store the exact outbound HighLevel request diagnostics in `message_events.request_payload`, including the final `request_body` sent to `/conversations/messages/inbound`.

### `GET /debug/oauth-status`

Returns whether a HighLevel OAuth token exists for the configured `GHL_LOCATION_ID`, whether a refresh token exists, `expires_at`, and `expired`. Real token values are never returned.

### `GET /debug/oauth-callback-config`

Returns non-secret OAuth callback settings: token URL, redirect URI, client ID present, client secret present, Marketplace App ID present, location ID present, and Supabase credentials present.

### `GET /debug/ghl-token-test`

Uses the stored OAuth access token for `GHL_LOCATION_ID` to call a simple HighLevel location endpoint. Returns success or failure, status code, endpoint, auth mode, and a redacted response body. It does not use or expose private integration tokens.

### `GET /debug/provider-config`

Returns the configured `GHL_CUSTOM_PROVIDER_ID`, whether it exactly equals `GHL_OAUTH_CLIENT_ID`, `GHL_LOCATION_ID`, configured inbound message type, configured inbound send auth mode, whether an OAuth token is present, and the selected auth mode. It never returns token or secret values.

### `GET /debug/inbound-send-auth-config`

Returns the production inbound send auth setting without secrets: configured `GHL_INBOUND_SEND_AUTH_MODE`, `GHL_LOCATION_API_AUTH_MODE`, effective inbound send auth mode, whether a Private Integration token is present, provider ID, location ID, and inbound message type. Effective inbound send auth should be `oauth`.

### `GET /debug/ghl-provider-test`

Uses the stored OAuth token and configured `GHL_CUSTOM_PROVIDER_ID` against the same inbound conversation-message path used for real LINE messages. Returns `provider_access_ok`, GHL status code, and any non-secret `canonicalCode` or message from HighLevel.

### `GET /debug/ghl-inbound-message-endpoint-test`

Uses the stored OAuth token, configured `GHL_CUSTOM_PROVIDER_ID`, and configured `GHL_INBOUND_MESSAGE_TYPE` to make the smallest safe inbound-message probe against HighLevel. It uses a fake contact ID, so a `400` validation response can be useful: it usually means the endpoint, auth class, and provider binding were reached and the remaining problem is payload/contact validation. The response includes endpoint path, method, auth mode, provider ID, location ID, redacted payload, status code, `canonicalCode` when present, redacted GHL response body, and a diagnosis label.

### `GET /debug/ghl-inbound-send-auth-test`

Uses the same safe fake inbound-message payload as the endpoint test, reports the configured `GHL_INBOUND_SEND_AUTH_MODE`, and sends with the required OAuth mode. A `400 CONVERSATIONS_CONTACT_NOT_FOUND` is expected with the fake contact ID and usually means OAuth reached HighLevel payload validation.

### `GET /debug/ghl-contact-auth-test`

Creates and updates a safe debug contact using `GHL_LOCATION_API_AUTH_MODE`. It returns the selected auth mode, whether the Private Integration token is present, endpoint, status code, `canonicalCode` when present, redacted HighLevel response body, and a diagnosis. Use this when LINE inbound fails at `/contacts/` before the message send step.

### `GET /debug/ghl-inbound-message-auth-matrix-test`

Uses the same safe fake inbound-message payload and compares HighLevel responses for stored Marketplace OAuth and Private Integration auth when `GHL_PRIVATE_INTEGRATION_TOKEN` is configured. It returns one redacted result per auth mode with endpoint, provider ID, inbound message type, status code, `canonicalCode`, message, response body, and diagnosis. Production LINE forwarding is forced to OAuth and is not changed by this diagnostic.

### `GET /debug/ghl-inbound-payload-matrix`

Protected in production by `WEBHOOK_SHARED_SECRET`. Uses the stored OAuth token only and an existing mapped `line_profiles` row for the configured `GHL_LOCATION_ID`. It does not create, update, or tag contacts, but it can create diagnostic messages in GHL when a payload variant succeeds. Returned request bodies redact message text, and token values are never returned. Keep this endpoint for support only.

### `GET /debug/ghl-token-install-summary`

Protected in production by `WEBHOOK_SHARED_SECRET`. Returns a safe summary of the stored OAuth install: token presence, DB location/company IDs, decoded authClass/authClassId/primaryAuthClassId/source/channel, scopes, expiry, and whether the required conversation/contact scopes are present. It never returns access or refresh tokens.

### `GET /oauth/callback`

HighLevel Marketplace OAuth callback. It accepts the `code` returned after app installation and never exposes token values. Direct Location responses are stored immediately. Company responses create a short-lived server-only onboarding session and return `pending_app_install`, `completed_locations`, or `failed`; they do not fan out across historical installed locations.

### `POST /webhooks/ghl/app-install`

Receives HighLevel `INSTALL` events at `https://win-crm.up.railway.app/webhooks/ghl/app-install`. It verifies `X-GHL-Signature` against the exact raw body, validates `appId`, `companyId`, and `locationId`, ensures the exact tenant, and durably reconciles that location with a matching Company OAuth session. Duplicate deliveries and reinstalls are idempotent. No shared-secret query parameter is used.

### `POST /webhooks/line`

Receives LINE webhook events. Requires a valid `x-line-signature` header. The route validates the payload, immediately returns `{ "ok": true, "accepted": true }`, then syncs events to HighLevel in the background.

### `POST /webhooks/line/inbound`

Alias for `POST /webhooks/line`.

### `POST /webhooks/ghl/outbound`

Receives outbound HighLevel custom provider messages. If `GHL_CUSTOM_PROVIDER_SECRET` is configured, include it in either `x-provider-secret` or `x-ghl-secret`.

### `POST /webhooks/ghl/line/outbound`

Alias for `POST /webhooks/ghl/outbound`.

The parser accepts common payload fields:

- `message`, `body`, `text`, `message.body`, or `message.text`
- `contactId` or `contact.id`
- `conversationId` or `conversation.id`
- `messageId`, `id`, or `message.id`
- `attachments`

### `POST /admin/mappings`

Links a LINE user to a HighLevel contact/conversation. Requires `WEBHOOK_SHARED_SECRET`.

## Hugo Setup Guide

This is the shortest path for deploying Hugo's current Railway production middleware.

### Production Launch Checklist

1. Run all Supabase migrations.
2. Deploy this repository to Railway from the `main` branch.
3. Add all Railway environment variables from `.env.example` using real values in Railway only.
4. Use the current Railway production URL: `https://win-crm.up.railway.app`.
5. Set the GHL Marketplace OAuth callback URL to `https://win-crm.up.railway.app/oauth/callback`.
6. Subscribe `AppInstall` to `https://win-crm.up.railway.app/webhooks/ghl/app-install`.
7. Install the GHL Marketplace app into the target location.
8. Test `GET /health`, `GET /debug/env-check`, and `GET /debug/oauth-status`.
9. Confirm `/debug/provider-config` shows the expected provider ID and production auth settings.
10. Set the LINE Developers webhook URL to `https://win-crm.up.railway.app/webhooks/line/inbound`.
11. Set the GHL Conversation Provider Delivery URL to `https://win-crm.up.railway.app/webhooks/ghl/line/outbound`.
12. Run the Production Smoke Test Checklist.

### Smoke Test

After deploy, run the top-level Production Smoke Test Checklist in this README.

### 1. Deploy To Railway

1. Deploy the `main` branch in Railway.
2. In Railway, choose **New Project**.
3. Choose **Deploy from GitHub repo**.
4. Select `hugolamcloser/line-ghl-connect-middleware`.
5. Let Railway detect the Node.js app. The project builds with `npm install` and starts with `npm start`.
6. Use the current production Railway domain: `https://win-crm.up.railway.app`.
7. Leave custom domain setup for the Future Custom Domain Migration section.

After deployment, test:

```text
GET https://win-crm.up.railway.app/health
GET https://win-crm.up.railway.app/debug/env-check
GET https://win-crm.up.railway.app/debug/oauth-status
```

### 2. Create The Supabase Project

1. Go to Supabase and create a new project.
2. Save the project password somewhere safe.
3. Open **Project Settings** then **API**.
4. Copy the project URL into `SUPABASE_URL`.
5. Copy the service role key into `SUPABASE_SERVICE_ROLE_KEY`.

The service role key is powerful. Put it only in Railway environment variables, never in frontend code.

### 3. Run The Supabase SQL Migration

1. Open your Supabase project.
2. Go to **SQL Editor**.
3. Open `supabase/migrations/202607020001_initial_schema.sql` from this repo.
4. Paste the full SQL into Supabase and click **Run**.
5. Open `supabase/migrations/202607030001_ghl_oauth_tokens.sql`.
6. Paste the full SQL into Supabase and click **Run**.
7. Open `supabase/migrations/202607060001_line_profiles_unique_line_user.sql`.
8. Paste the full SQL into Supabase and click **Run**.
9. Apply `supabase/migrations/202607080001_line_channels.sql` and `supabase/migrations/202607110001_ghl_oauth_onboarding.sql` in the same way.
10. `Success. No rows returned` is the expected result for these migrations.
11. Confirm `ghl_oauth_onboarding_sessions` and `ghl_pending_app_installs` exist in addition to the existing tenant, LINE, webhook, and OAuth tables.
12. Keep `SUPABASE_SERVICE_ROLE_KEY` only in Railway service variables. Never paste it into public docs, frontend code, or client apps.

### 4. Add Railway Environment Variables

Add these variables in Railway under your service's **Variables** tab:

```text
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
PUBLIC_BASE_URL=https://win-crm.up.railway.app
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
GHL_API_BASE_URL=https://services.leadconnectorhq.com
GHL_API_VERSION=2021-07-28
GHL_LOCATION_ID=...
GHL_CUSTOM_PROVIDER_ID=...
GHL_OAUTH_CLIENT_ID=...
GHL_OAUTH_CLIENT_SECRET=...
GHL_OAUTH_REDIRECT_URI=https://win-crm.up.railway.app/oauth/callback
GHL_OAUTH_TOKEN_URL=https://services.leadconnectorhq.com/oauth/token
GHL_MARKETPLACE_APP_ID=...
GHL_INBOUND_MESSAGE_TYPE=Custom
GHL_SEND_CONVERSATION_PROVIDER_ID=true
GHL_LOCATION_API_AUTH_MODE=private_integration
GHL_INBOUND_SEND_AUTH_MODE=oauth
GHL_LINE_USER_ID_FIELD_ID=
GHL_LINE_DISPLAY_NAME_FIELD_ID=
# Deprecated/testing only. Keep false in production.
GHL_ALLOW_PRIVATE_TOKEN_FALLBACK=false
GHL_PRIVATE_INTEGRATION_TOKEN=...
GHL_CUSTOM_PROVIDER_SECRET=...
WEBHOOK_SHARED_SECRET=...
```

Then open:

```text
https://win-crm.up.railway.app/debug/env-check
```

Every required variable should show `present`. Optional variables may be `missing`. This endpoint never shows the actual secret values.

### 5. Get LINE Credentials

For normal multi-tenant customers, do not create per-subaccount Railway LINE variables. After the app is installed, connect that customer's LINE Official Account through the LINE custom page. The page stores the channel credentials in `line_channels` and provides the tenant-specific webhook URL.

Use the legacy/default `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, and `/webhooks/line/inbound` path only for old single-location deployments or support diagnostics.

### 6. Get GHL Marketplace OAuth Credentials

1. In HighLevel, open your Marketplace app.
2. Set the app OAuth callback URL to:

```text
https://win-crm.up.railway.app/oauth/callback
```

3. Copy the Marketplace app client ID into `GHL_OAUTH_CLIENT_ID`.
4. Copy the Marketplace app client secret into `GHL_OAUTH_CLIENT_SECRET`.
5. Copy the Marketplace App ID into `GHL_MARKETPLACE_APP_ID`. Do not use `GHL_OAUTH_CLIENT_ID` as the app ID.
6. Put `https://win-crm.up.railway.app/oauth/callback` into `GHL_OAUTH_REDIRECT_URI`.
7. Subscribe `AppInstall` to `https://win-crm.up.railway.app/webhooks/ghl/app-install`.
8. Install the Marketplace app into any target location. The callback and AppInstall event may arrive in either order; the middleware will create the exact location token without manually entering a location ID.
9. Connect that customer's LINE Official Account through the LINE custom page.
10. Use the production smoke test below to confirm the full LINE to GHL and GHL to LINE flow.
11. Use deeper debug endpoints only during support or migration work.

### 7. Configure The GHL Conversation Provider

1. Create or open your custom Conversation Provider for the target location.
2. Copy the custom provider ID into `GHL_CUSTOM_PROVIDER_ID`.
3. Set `GHL_INBOUND_MESSAGE_TYPE=Custom` and `GHL_SEND_CONVERSATION_PROVIDER_ID=true` for the confirmed production LINE provider.
4. Optionally create GHL custom fields for LINE user ID and LINE display name, then put their field IDs into `GHL_LINE_USER_ID_FIELD_ID` and `GHL_LINE_DISPLAY_NAME_FIELD_ID`.
5. If tag creation/update is enabled through this integration, make sure the Marketplace app has the tag scopes `locations/tags.readonly` and `locations/tags.write`.
6. If the provider lets you set a delivery secret, use the same value as `GHL_CUSTOM_PROVIDER_SECRET`.
7. Set the custom provider Delivery URL to:

```text
https://win-crm.up.railway.app/webhooks/ghl/line/outbound
```

This Delivery URL is for GHL replies going back to LINE. It is not the OAuth callback URL and it is not the LINE webhook URL.

### 8. Test LINE To GHL

1. Confirm `/debug/env-check` shows required variables as `present`.
2. Send a text message to the LINE Official Account from a real LINE user.
3. Confirm the message appears inside the GHL contact conversation thread.
4. In Supabase, check the latest `message_events` row for that LINE message shows `status=success` and `error_message` is `null`.
5. If the message does not appear, open `/debug/recent-events` and inspect the redacted latest `message_events` row.

### 9. Test GHL To LINE

1. Open the GHL conversation that was created or mapped from LINE.
2. Send a reply from GHL.
3. GHL should POST to `https://win-crm.up.railway.app/webhooks/ghl/line/outbound`.
4. The middleware should find the Supabase mapping and push the reply to the LINE user.
5. Check `message_events` in Supabase if the message does not arrive.

### 10. Common Errors And Debugging

- `Invalid LINE signature`: Check `LINE_CHANNEL_SECRET`, confirm the webhook URL is exactly `/webhooks/line/inbound`, and make sure LINE is sending directly to the deployed service.
- `LINE API 401`: Check `LINE_CHANNEL_ACCESS_TOKEN`.
- `HighLevel API 401` at `/contacts/`: Confirm `GHL_LOCATION_API_AUTH_MODE=private_integration` and `GHL_PRIVATE_INTEGRATION_TOKEN` are still set in Railway. Use `/debug/ghl-contact-auth-test` only for support diagnostics.
- `HighLevel API 401`: Check `/debug/oauth-status` first. If there is no token, install the Marketplace app. If the token exists, open `/debug/ghl-token-test`; the response usually separates token, scope, endpoint, and location problems.
- `HighLevel API 422` from `/conversations/messages/inbound`: Open `/debug/recent-events` and inspect the latest `message_events.request_payload.request_body`. For text messages it should match the proven payload shape: `locationId`, `contactId`, `type`, `message`, `conversationProviderId` when enabled, `externalConversationId` as `line:{LINE_USER_ID}`, and `externalMessageId`. Text-only messages should omit `attachments` completely.
- `CONVERSATIONS_MSG_PROVIDER_NO_ACCESS`: OAuth is working, but the configured Conversation Provider is not accessible. Check `/debug/provider-config` first. If `provider_id_equals_oauth_client_id` is `true`, replace `GHL_CUSTOM_PROVIDER_ID` with the real custom Conversation Provider ID. If it is `false`, confirm the provider is installed for this GHL location and tied to the current Marketplace app version.
- `This authClass type is not allowed to access this scope`: OAuth token storage is working, but HighLevel is rejecting the app/provider authorization for the inbound-message API. Keep the confirmed production auth values unchanged unless you are migrating. If support needs deeper diagnostics, open `/debug/ghl-token-install-summary` and `/debug/ghl-inbound-payload-matrix` with `WEBHOOK_SHARED_SECRET` in production.
- Support-only inbound diagnostics disagree with production smoke tests: trust the real smoke test first. Use matrix/provider/debug endpoints only to investigate a new HighLevel app, provider, or location migration.
- `HighLevel create contact response did not include a contact id`: The GHL create-contact response shape changed or the token cannot create contacts. Check the Railway logs and the HighLevel API response.
- `GHL_MARKETPLACE_APP_ID is required`: Add the Marketplace App ID to Railway and confirm the signed AppInstall event is delivered to `/webhooks/ghl/app-install`.
- `GHL_LOCATION_ID is required`: This only affects legacy/default diagnostics. It must not be used to identify a new OAuth installation.
- `GHL_CUSTOM_PROVIDER_ID is required`: Add the Conversation Provider ID to Railway and redeploy.
- GHL replies do not reach LINE: Confirm the GHL provider delivery URL is `/webhooks/ghl/line/outbound`, confirm `GHL_CUSTOM_PROVIDER_SECRET` matches if you use one, and confirm the GHL contact or conversation exists in `line_profiles`.
- Railway deploy is live but webhooks fail: Open `/health`, then `/debug/env-check`, then Railway logs. Fix missing variables first.
- `webhook_events` is empty: Older versions did not write incoming LINE events there. After this update, every incoming LINE event should create or update a `webhook_events` row.
- `message_events` has `failed` with `HighLevel API 401`: The installed-location OAuth token is missing, expired and not refreshable, lacks required scopes, or belongs to a different location.
- LINE tags/custom fields missing but messages still sync: Check Marketplace scopes and custom field IDs. Tag/custom-field updates are warning-only so they do not block message forwarding.

## Deployment Notes

- Deploy behind HTTPS. LINE and HighLevel webhooks should not target plain HTTP in production.
- Keep Supabase service role credentials server-side only.
- Preserve raw request bodies for LINE signature validation.
- Review message attachment handling before enabling binary media sync. This starter records non-text LINE messages as text placeholders.
- For multi-location deployments, extend `tenants` and route selection so each provider/channel pair can use distinct LINE and GHL credentials.
- `line_profiles` stores the LINE user ID to GHL contact ID mapping.
- `message_events` stores sent, skipped, and failed message sync attempts.
- `webhook_events` stores incoming LINE/GHL webhook payloads and when background processing finished.
- `ghl_oauth_tokens` stores HighLevel Marketplace OAuth access and refresh tokens server-side only.

## Troubleshooting

- `Invalid LINE signature`: Verify `LINE_CHANNEL_SECRET`, webhook URL, and that no proxy reformats the request body.
- GHL contact was created for the wrong person: Link the LINE user to the correct existing contact through `/admin/mappings`.
- Outbound messages skipped: Confirm the GHL webhook payload includes a `contactId` or `conversationId` that exists in `line_profiles`.
- HighLevel API errors: Check `/debug/oauth-status`, `/debug/ghl-token-test`, `GHL_API_VERSION`, provider ID, location ID, OAuth scopes, and the redacted `message_events` payload.
- Confusing LINE test replies: Disable LINE auto-response in LINE Official Account Manager.
