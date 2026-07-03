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

Important values:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: Supabase backend credentials. Use the service role key only on the server.
- `LINE_CHANNEL_SECRET`: Used to verify LINE webhook signatures.
- `LINE_CHANNEL_ACCESS_TOKEN`: Used to call LINE profile and push message APIs.
- `GHL_LOCATION_ID`: HighLevel location ID.
- `GHL_CUSTOM_PROVIDER_ID`: Your HighLevel custom Conversation Provider ID.
- `GHL_INBOUND_MESSAGE_TYPE`: HighLevel inbound message `type`. Use `SMS` for an added SMS custom conversation channel, which is the expected LINE setup. Use `Custom` only for an extra Email provider style setup.
- `GHL_LOCATION_API_AUTH_MODE`: Auth mode for LINE inbound location-level writes: contact create, contact fetch/update, tags, and optional custom fields. Default is `oauth`. Set to `private_integration` when OAuth returns an authClass `401` for contact writes.
- `GHL_INBOUND_SEND_AUTH_MODE`: Auth mode used only for `POST /conversations/messages/inbound`. Default is `oauth`. Set to `private_integration` only when the auth matrix shows OAuth is authClass-blocked while Private Integration reaches HighLevel validation.
- `GHL_OAUTH_CLIENT_ID`, `GHL_OAUTH_CLIENT_SECRET`, and `GHL_OAUTH_REDIRECT_URI`: HighLevel Marketplace app OAuth settings. Production LINE to GHL forwarding uses the installed location OAuth token stored in Supabase.
- `GHL_LINE_USER_ID_FIELD_ID`: Optional GHL custom field ID for storing the LINE user ID.
- `GHL_LINE_DISPLAY_NAME_FIELD_ID`: Optional GHL custom field ID for storing the LINE display name.
- `GHL_PRIVATE_INTEGRATION_TOKEN`: Required when `GHL_LOCATION_API_AUTH_MODE=private_integration` or `GHL_INBOUND_SEND_AUTH_MODE=private_integration`. Also available as an optional dev fallback only when `GHL_ALLOW_PRIVATE_TOKEN_FALLBACK=true`.
- `GHL_CUSTOM_PROVIDER_SECRET`: Optional shared secret for outbound webhooks from HighLevel.
- `WEBHOOK_SHARED_SECRET`: Optional shared secret for the admin mapping endpoint.

## Supabase Setup

Apply both migrations in order:

1. `supabase/migrations/202607020001_initial_schema.sql`
2. `supabase/migrations/202607030001_ghl_oauth_tokens.sql`

Using the Supabase CLI:

```bash
supabase db push
```

Or paste each SQL migration into the Supabase SQL editor and run them one at a time.

Seeing `Success. No rows returned` after running the migration is normal because the SQL creates schema objects and does not return table rows. RLS can be enabled on the tables; this backend uses `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS for server-side operations. Do not expose `SUPABASE_SERVICE_ROLE_KEY` publicly, in browser code, or in mobile apps.

The OAuth migration creates `ghl_oauth_tokens` for server-side Marketplace install tokens and adds GHL debug columns to `message_events`. Never expose `access_token` or `refresh_token` values from Supabase.

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

Assuming `PUBLIC_BASE_URL=https://api.win-crm.ai`:

- LINE webhook URL: `https://api.win-crm.ai/webhooks/line/inbound`
- HighLevel outbound provider webhook URL: `https://api.win-crm.ai/webhooks/ghl/line/outbound`
- HighLevel Marketplace OAuth callback URL: `https://api.win-crm.ai/oauth/callback`
- Health check: `https://api.win-crm.ai/health`
- Safe environment check: `https://api.win-crm.ai/debug/env-check`
- OAuth token status: `https://api.win-crm.ai/debug/oauth-status`
- OAuth callback config: `https://api.win-crm.ai/debug/oauth-callback-config`
- OAuth token test: `https://api.win-crm.ai/debug/ghl-token-test`
- Provider config check: `https://api.win-crm.ai/debug/provider-config`
- Provider access test: `https://api.win-crm.ai/debug/ghl-provider-test`
- Inbound message endpoint test: `https://api.win-crm.ai/debug/ghl-inbound-message-endpoint-test`
- Inbound send auth config: `https://api.win-crm.ai/debug/inbound-send-auth-config`
- Configured inbound send auth test: `https://api.win-crm.ai/debug/ghl-inbound-send-auth-test`
- Contact auth test: `https://api.win-crm.ai/debug/ghl-contact-auth-test`
- Inbound auth matrix test: `https://api.win-crm.ai/debug/ghl-inbound-message-auth-matrix-test`

The original route names still work:

- `POST /webhooks/line`
- `POST /webhooks/ghl/outbound`

## LINE Configuration

1. Open the LINE Developers Console.
2. Select your Messaging API channel.
3. Set the webhook URL to `https://api.win-crm.ai/webhooks/line/inbound`.
4. Enable webhooks.
5. Disable auto-reply settings if HighLevel should own replies.
6. Copy the channel secret and long-lived channel access token into `.env`.

LINE signatures are verified against the exact raw UTF-8 body, so do not put middleware or proxies in front of this service that rewrite JSON bodies before they reach Express.

## HighLevel Configuration

1. Create or open the HighLevel Marketplace app for this middleware.
2. Set the Marketplace app OAuth callback URL to `https://api.win-crm.ai/oauth/callback`.
3. Add the Marketplace app client ID and client secret to Railway as `GHL_OAUTH_CLIENT_ID` and `GHL_OAUTH_CLIENT_SECRET`.
4. Install the Marketplace app into the target GHL location so HighLevel redirects to `/oauth/callback?code=...`.
5. Confirm `GET /debug/oauth-status` shows `token_present: true` for your `GHL_LOCATION_ID`.
6. Configure a custom Conversation Provider for the target location.
7. Put the actual custom Conversation Provider ID into `GHL_CUSTOM_PROVIDER_ID`. This is not the Marketplace OAuth client ID.
8. For LINE, set `GHL_INBOUND_MESSAGE_TYPE=SMS`. HighLevel documents added SMS custom conversation channels as `type: "SMS"` plus `conversationProviderId`.
9. Set the provider Delivery URL to `https://api.win-crm.ai/webhooks/ghl/line/outbound`.
10. If the provider supports a custom header or secret field, set it to `GHL_CUSTOM_PROVIDER_SECRET`.
11. Put the provider ID, location ID, OAuth client settings, inbound message type, and API version into `.env`.
12. Open `/debug/provider-config`; if `provider_id_equals_oauth_client_id` is `true`, `GHL_CUSTOM_PROVIDER_ID` is almost certainly wrong.
13. Open `/debug/ghl-provider-test` and `/debug/ghl-inbound-message-endpoint-test` to verify the stored OAuth token can access the configured provider ID and inbound endpoint.
14. If OAuth still returns `This authClass type is not allowed to access this scope`, open `/debug/ghl-inbound-message-auth-matrix-test` to compare Marketplace OAuth against `GHL_PRIVATE_INTEGRATION_TOKEN`.
15. If contact creation fails with an authClass `401`, set `GHL_LOCATION_API_AUTH_MODE=private_integration`, redeploy, and confirm `/debug/ghl-contact-auth-test` can create/update a debug contact.
16. If the matrix shows OAuth is authClass-blocked and Private Integration reaches validation, set `GHL_INBOUND_SEND_AUTH_MODE=private_integration`, redeploy, and confirm `/debug/ghl-inbound-send-auth-test` reaches validation before testing a real LINE message.

The inbound message client posts to:

```text
POST /conversations/messages/inbound
```

with the configured `Version` header. By default, the middleware uses the stored Marketplace OAuth access token for the location. If the OAuth access token is expired or close to expiry, the middleware refreshes it and retries a 401 once. If `GHL_LOCATION_API_AUTH_MODE=private_integration`, LINE inbound contact create/update/tag/custom-field calls use `GHL_PRIVATE_INTEGRATION_TOKEN`. If either `GHL_LOCATION_API_AUTH_MODE=private_integration` or `GHL_INBOUND_SEND_AUTH_MODE=private_integration`, the real inbound-message send uses the Private Integration token too so the LINE inbound flow does not mix auth classes. OAuth install, OAuth callback, and OAuth refresh/storage stay on the OAuth path.

For an added SMS custom conversation provider, the payload uses `type: "SMS"` and includes `conversationProviderId`. For an extra Email custom provider, HighLevel documents `type: "Custom"` and `conversationProviderId`. Use `GHL_INBOUND_MESSAGE_TYPE` only to match the provider type configured in HighLevel.

If `/debug/oauth-status` shows `token_present: true` and `refresh_token_present: true`, the Marketplace OAuth install/token storage is working. If message forwarding then fails with `CONVERSATIONS_MSG_PROVIDER_NO_ACCESS`, the configured `GHL_CUSTOM_PROVIDER_ID` is wrong, not installed for this location, or not connected to the currently installed Marketplace app version.

If HighLevel returns `This authClass type is not allowed to access this scope`, the OAuth token can exist and still be rejected by the inbound-message API. Check that the Marketplace app version installed in the location includes the Conversation Provider module, that the provider was created under that same app/version, that the location has the provider installed under Settings > Conversation Providers, and that `GHL_INBOUND_MESSAGE_TYPE` matches the provider type.

If `/debug/ghl-inbound-message-auth-matrix-test` shows OAuth returns that authClass `401` while Private Integration returns a `400` such as `CONVERSATIONS_CONTACT_NOT_FOUND`, Private Integration reached HighLevel payload validation and can be used for the real inbound send call. Set `GHL_LOCATION_API_AUTH_MODE=private_integration` and `GHL_INBOUND_SEND_AUTH_MODE=private_integration`, keep `GHL_INBOUND_MESSAGE_TYPE=SMS`, redeploy, then run `/debug/ghl-contact-auth-test`, `/debug/inbound-send-auth-config`, and `/debug/ghl-inbound-send-auth-test` before sending a real LINE message.

The Conversation Provider Delivery URL is only for GHL to middleware outbound messages. LINE inbound messages come from the LINE webhook and are then written into GHL through the LeadConnector API using the auth modes selected by `GHL_LOCATION_API_AUTH_MODE` and `GHL_INBOUND_SEND_AUTH_MODE`. Marketplace webhooks are separate from the Conversation Provider Delivery URL and are not required for this app unless you add separate GHL event-notification features.

## Mapping A LINE User To A GHL Contact

Inbound LINE events create or update a `line_profiles` row. If that LINE user is already linked to a GHL contact, the message is forwarded to that contact. If no mapping exists yet, the middleware creates a new GHL contact using the LINE display name, saves the `line_user_id` to `ghl_contact_id` mapping in Supabase, then forwards the same inbound LINE message into GHL.

Every LINE-backed contact is created or updated with these tags:

- `line`
- `line:{LINE_USER_ID}`

For example: `line:U93ebe957edac218bfa9b204bc8060446`. The contact source stays `LINE Official Account` when the GHL API accepts that field. Optional LINE custom fields are updated when `GHL_LINE_USER_ID_FIELD_ID` and `GHL_LINE_DISPLAY_NAME_FIELD_ID` are configured.

The admin endpoint remains available as an override tool. Use it when you want to attach a LINE user to an existing GHL contact or conversation:

```bash
curl -X POST https://api.win-crm.ai/admin/mappings \
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

Returns the latest 10 `line_profiles`, latest 10 `message_events`, and latest 10 `webhook_events` rows. Secret values are redacted. `message_events` includes sync status, `error_message`, GHL status code, GHL response body, and redacted request payload when available.

### `GET /debug/oauth-status`

Returns whether a HighLevel OAuth token exists for the configured `GHL_LOCATION_ID`, whether a refresh token exists, `expires_at`, and `expired`. Real token values are never returned.

### `GET /debug/oauth-callback-config`

Returns non-secret OAuth callback settings: token URL, redirect URI, client ID present, client secret present, location ID present, and Supabase credentials present.

### `GET /debug/ghl-token-test`

Uses the stored OAuth access token for `GHL_LOCATION_ID` to call a simple HighLevel location endpoint. Returns success or failure, status code, endpoint, auth mode, and a redacted response body. It does not use or expose private integration tokens.

### `GET /debug/provider-config`

Returns the configured `GHL_CUSTOM_PROVIDER_ID`, whether it exactly equals `GHL_OAUTH_CLIENT_ID`, `GHL_LOCATION_ID`, configured inbound message type, configured inbound send auth mode, whether an OAuth token is present, and the selected auth mode. It never returns token or secret values.

### `GET /debug/inbound-send-auth-config`

Returns the production inbound send auth setting without secrets: `GHL_INBOUND_SEND_AUTH_MODE`, `GHL_LOCATION_API_AUTH_MODE`, effective inbound send auth mode, whether a Private Integration token is present, provider ID, location ID, and inbound message type.

### `GET /debug/ghl-provider-test`

Uses the stored OAuth token and configured `GHL_CUSTOM_PROVIDER_ID` against the same inbound conversation-message path used for real LINE messages. Returns `provider_access_ok`, GHL status code, and any non-secret `canonicalCode` or message from HighLevel.

### `GET /debug/ghl-inbound-message-endpoint-test`

Uses the stored OAuth token, configured `GHL_CUSTOM_PROVIDER_ID`, and configured `GHL_INBOUND_MESSAGE_TYPE` to make the smallest safe inbound-message probe against HighLevel. It uses a fake contact ID, so a `400` validation response can be useful: it usually means the endpoint, auth class, and provider binding were reached and the remaining problem is payload/contact validation. The response includes endpoint path, method, auth mode, provider ID, location ID, redacted payload, status code, `canonicalCode` when present, redacted GHL response body, and a diagnosis label.

### `GET /debug/ghl-inbound-send-auth-test`

Uses the same safe fake inbound-message payload as the endpoint test, but sends it with the auth mode configured by `GHL_INBOUND_SEND_AUTH_MODE`. Use this before a real LINE test after switching to `private_integration`. A `400 CONVERSATIONS_CONTACT_NOT_FOUND` is expected with the fake contact ID and usually means the configured auth mode reached HighLevel payload validation.

### `GET /debug/ghl-contact-auth-test`

Creates and updates a safe debug contact using `GHL_LOCATION_API_AUTH_MODE`. It returns the selected auth mode, whether the Private Integration token is present, endpoint, status code, `canonicalCode` when present, redacted HighLevel response body, and a diagnosis. Use this when LINE inbound fails at `/contacts/` before the message send step.

### `GET /debug/ghl-inbound-message-auth-matrix-test`

Uses the same safe fake inbound-message payload and compares HighLevel responses for stored Marketplace OAuth and Private Integration auth when `GHL_PRIVATE_INTEGRATION_TOKEN` is configured. It returns one redacted result per auth mode with endpoint, provider ID, inbound message type, status code, `canonicalCode`, message, response body, and diagnosis. If OAuth gets a `401` auth-class error while Private Integration reaches `400` payload validation or succeeds, the response recommends `private_integration` for investigation. Production LINE forwarding is not changed by this diagnostic.

### `GET /oauth/callback`

HighLevel Marketplace OAuth callback. It accepts the `code` returned after app installation, exchanges it for access and refresh tokens, stores them in Supabase, and returns safe install status without exposing token values.

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

This is the shortest path for deploying Hugo's `api.win-crm.ai` middleware from a fresh account setup.

### Production Launch Checklist

1. Run both Supabase migrations.
2. Deploy this repository to Railway from the `main` branch.
3. Add all Railway environment variables from `.env.example` using real values in Railway only.
4. Connect the custom domain `api.win-crm.ai` in Railway.
5. Set the GHL Marketplace OAuth callback URL to `https://api.win-crm.ai/oauth/callback`.
6. Install the GHL Marketplace app into the target location.
7. Test `GET /health`, `GET /debug/env-check`, `GET /debug/oauth-callback-config`, `GET /debug/oauth-status`, and `GET /debug/ghl-token-test`.
8. Test `GET /debug/provider-config` and `GET /debug/ghl-provider-test`.
9. Set the LINE Developers webhook URL to `https://api.win-crm.ai/webhooks/line/inbound`.
10. Set the GHL Conversation Provider Delivery URL to `https://api.win-crm.ai/webhooks/ghl/line/outbound`.
11. Send a real LINE message and confirm it appears inside the GHL contact conversation thread.
12. Reply from GHL and confirm the message is pushed back to LINE.

### 1. Deploy To Railway

1. Deploy the `main` branch in Railway.
2. In Railway, choose **New Project**.
3. Choose **Deploy from GitHub repo**.
4. Select `hugolamcloser/line-ghl-connect-middleware`.
5. Let Railway detect the Node.js app. The project builds with `npm install` and starts with `npm start`.
6. Open the Railway service settings and add your custom domain `api.win-crm.ai`.
7. Keep the generated Railway domain too. It is useful for testing before DNS is ready.

After deployment, test:

```text
GET https://api.win-crm.ai/health
GET https://api.win-crm.ai/debug/env-check
GET https://api.win-crm.ai/debug/oauth-status
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
7. `Success. No rows returned` is the expected result for both migrations.
8. If you clicked **Run and enable RLS**, that is okay for this backend because it uses `SUPABASE_SERVICE_ROLE_KEY`.
9. Confirm these tables exist: `tenants`, `line_profiles`, `message_events`, `webhook_events`, and `ghl_oauth_tokens`.
10. Keep `SUPABASE_SERVICE_ROLE_KEY` only in Railway service variables. Never paste it into public docs, frontend code, or client apps.

### 4. Add Railway Environment Variables

Add these variables in Railway under your service's **Variables** tab:

```text
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
PUBLIC_BASE_URL=https://api.win-crm.ai
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
GHL_OAUTH_REDIRECT_URI=https://api.win-crm.ai/oauth/callback
GHL_OAUTH_TOKEN_URL=https://services.leadconnectorhq.com/oauth/token
GHL_INBOUND_MESSAGE_TYPE=SMS
GHL_LOCATION_API_AUTH_MODE=oauth
GHL_INBOUND_SEND_AUTH_MODE=oauth
GHL_LINE_USER_ID_FIELD_ID=
GHL_LINE_DISPLAY_NAME_FIELD_ID=
GHL_ALLOW_PRIVATE_TOKEN_FALLBACK=false
GHL_PRIVATE_INTEGRATION_TOKEN=
GHL_CUSTOM_PROVIDER_SECRET=...
WEBHOOK_SHARED_SECRET=...
```

Then open:

```text
https://api.win-crm.ai/debug/env-check
```

Every required variable should show `present`. Optional variables may be `missing`. This endpoint never shows the actual secret values.

### 5. Get LINE Credentials

1. Open the LINE Developers Console.
2. Choose your provider and Messaging API channel.
3. In **Basic settings**, copy **Channel secret** into `LINE_CHANNEL_SECRET`.
4. In **Messaging API**, issue or copy the long-lived **Channel access token** into `LINE_CHANNEL_ACCESS_TOKEN`.
5. In **Messaging API**, set the webhook URL to:

```text
https://api.win-crm.ai/webhooks/line/inbound
```

6. Enable **Use webhook**.
7. Disable LINE auto-reply if HighLevel should handle the replies.
8. In LINE Official Account Manager, disable auto-response messages so test replies are not confused with HighLevel replies.

### 6. Get GHL Marketplace OAuth Credentials

1. In HighLevel, open your Marketplace app.
2. Set the app OAuth callback URL to:

```text
https://api.win-crm.ai/oauth/callback
```

3. Copy the Marketplace app client ID into `GHL_OAUTH_CLIENT_ID`.
4. Copy the Marketplace app client secret into `GHL_OAUTH_CLIENT_SECRET`.
5. Find the target location ID in the location settings, business profile, or the HighLevel URL. Put it in `GHL_LOCATION_ID`.
6. Put `https://api.win-crm.ai/oauth/callback` into `GHL_OAUTH_REDIRECT_URI`.
7. Install the Marketplace app into the target location. HighLevel should redirect to `/oauth/callback?code=...`, and the middleware will store the access and refresh tokens in Supabase.
8. Open `https://api.win-crm.ai/debug/oauth-status` and confirm `token_present` and `refresh_token_present` are `true`.
9. Open `https://api.win-crm.ai/debug/ghl-token-test` and confirm the stored OAuth token can call HighLevel.
10. Open `https://api.win-crm.ai/debug/provider-config` and confirm `provider_id_equals_oauth_client_id` is `false`.
11. Open `https://api.win-crm.ai/debug/ghl-provider-test` and confirm `provider_access_ok` is not failing with `CONVERSATIONS_MSG_PROVIDER_NO_ACCESS`.
12. Open `https://api.win-crm.ai/debug/ghl-inbound-message-endpoint-test` and read the diagnosis. A `400` caused by the fake contact ID is better than a `401` because it means HighLevel reached request validation.
13. Open `https://api.win-crm.ai/debug/ghl-inbound-message-auth-matrix-test` only when you need to compare Marketplace OAuth against Private Integration auth for the same inbound-message endpoint.
14. If contact creation fails with an authClass `401`, set `GHL_LOCATION_API_AUTH_MODE=private_integration`, redeploy, then open `https://api.win-crm.ai/debug/ghl-contact-auth-test`.
15. If the matrix shows OAuth returns authClass `401` and Private Integration returns `400 CONVERSATIONS_CONTACT_NOT_FOUND`, set `GHL_INBOUND_SEND_AUTH_MODE=private_integration`, redeploy, then open `https://api.win-crm.ai/debug/ghl-inbound-send-auth-test`.

### 7. Configure The GHL Conversation Provider

1. Create or open your custom Conversation Provider for the target location.
2. Copy the custom provider ID into `GHL_CUSTOM_PROVIDER_ID`.
3. Set `GHL_INBOUND_MESSAGE_TYPE=SMS` for an added SMS custom conversation channel. Use `Custom` only if the provider is configured as an extra Email custom provider.
4. Optionally create GHL custom fields for LINE user ID and LINE display name, then put their field IDs into `GHL_LINE_USER_ID_FIELD_ID` and `GHL_LINE_DISPLAY_NAME_FIELD_ID`.
5. If tag creation/update is enabled through this integration, make sure the Marketplace app has the tag scopes `locations/tags.readonly` and `locations/tags.write`.
6. If the provider lets you set a delivery secret, use the same value as `GHL_CUSTOM_PROVIDER_SECRET`.
7. Set the custom provider Delivery URL to:

```text
https://api.win-crm.ai/webhooks/ghl/line/outbound
```

This Delivery URL is for GHL replies going back to LINE. It is not the OAuth callback URL and it is not the LINE webhook URL.

### 8. Test LINE To GHL

1. Confirm `/debug/env-check` shows all required variables as `present`.
2. Confirm `/debug/oauth-status` shows a stored token for `GHL_LOCATION_ID`.
3. Confirm `/debug/ghl-token-test` succeeds.
4. Open `/debug/ghl-contact-auth-test` and confirm contact create/update works with the intended `GHL_LOCATION_API_AUTH_MODE`.
5. Open `/debug/inbound-send-auth-config` and confirm the intended `GHL_INBOUND_SEND_AUTH_MODE`.
6. Open `/debug/ghl-inbound-send-auth-test`. If `private_integration` is selected, a `400 CONVERSATIONS_CONTACT_NOT_FOUND` from the fake contact ID is acceptable and means HighLevel reached payload validation.
7. Send a text message to the LINE Official Account from a real LINE user.
8. In Supabase, check that `webhook_events` has the raw LINE event.
9. Check that `line_profiles` has a row for that `line_user_id` and a `ghl_contact_id`.
10. Confirm the GHL contact has source `LINE Official Account` if GHL accepted it.
11. Confirm the GHL contact has tags `line` and `line:{LINE_USER_ID}`.
12. Confirm the LINE message appears inside the GHL contact conversation thread.
13. If the message does not appear, open `/debug/recent-events` and inspect `message_events` for `status`, `error_message`, `ghl_status_code`, `ghl_response_body`, and `request_payload`.

### 9. Test GHL To LINE

1. Open the GHL conversation that was created or mapped from LINE.
2. Send a reply from GHL.
3. GHL should POST to `https://api.win-crm.ai/webhooks/ghl/line/outbound`.
4. The middleware should find the Supabase mapping and push the reply to the LINE user.
5. Check `message_events` in Supabase if the message does not arrive.

### 10. Common Errors And Debugging

- `Invalid LINE signature`: Check `LINE_CHANNEL_SECRET`, confirm the webhook URL is exactly `/webhooks/line/inbound`, and make sure LINE is sending directly to the deployed service.
- `LINE API 401`: Check `LINE_CHANNEL_ACCESS_TOKEN`.
- `HighLevel API 401` at `/contacts/`: Open `/debug/ghl-contact-auth-test`. If OAuth returns authClass `401`, set `GHL_LOCATION_API_AUTH_MODE=private_integration`, ensure `GHL_PRIVATE_INTEGRATION_TOKEN` is present, and redeploy.
- `HighLevel API 401`: Check `/debug/oauth-status` first. If there is no token, install the Marketplace app. If the token exists, open `/debug/ghl-token-test`; the response usually separates token, scope, endpoint, and location problems.
- `CONVERSATIONS_MSG_PROVIDER_NO_ACCESS`: OAuth is working, but the configured Conversation Provider is not accessible. Check `/debug/provider-config` first. If `provider_id_equals_oauth_client_id` is `true`, replace `GHL_CUSTOM_PROVIDER_ID` with the real custom Conversation Provider ID. If it is `false`, confirm the provider is installed for this GHL location and tied to the current Marketplace app version.
- `This authClass type is not allowed to access this scope`: OAuth token storage is working, but HighLevel is rejecting the app/provider authorization for the inbound-message API. Open `/debug/ghl-inbound-message-endpoint-test`, confirm `GHL_INBOUND_MESSAGE_TYPE=SMS`, confirm the app has the Conversation Provider Marketplace module and `conversations/message.write`, reinstall the current app version into the location, and verify the provider appears under Settings > Conversation Providers.
- `/debug/ghl-inbound-message-auth-matrix-test` recommends `private_integration`: OAuth was rejected by auth class, but Private Integration auth reached request validation or success for the same endpoint and payload. Set both `GHL_LOCATION_API_AUTH_MODE=private_integration` and `GHL_INBOUND_SEND_AUTH_MODE=private_integration`, redeploy, then confirm `/debug/ghl-contact-auth-test` and `/debug/ghl-inbound-send-auth-test` before sending a real LINE message.
- `/debug/ghl-inbound-message-auth-matrix-test` shows both auth modes return `401`: Verify the HighLevel Marketplace Conversation Provider module, app install, provider binding, provider ID, and location with GHL support.
- `/debug/ghl-inbound-message-endpoint-test` returns `400`: This may be expected because the probe uses a fake contact ID. If the diagnosis says payload validation was reached, send a real LINE message and inspect `/debug/recent-events`.
- `HighLevel create contact response did not include a contact id`: The GHL create-contact response shape changed or the token cannot create contacts. Check the Railway logs and the HighLevel API response.
- `GHL_LOCATION_ID is required` or `GHL_CUSTOM_PROVIDER_ID is required`: Add the missing Railway variable and redeploy.
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
