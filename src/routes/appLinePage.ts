import crypto from "node:crypto";
import express from "express";
import type { Request, Response } from "express";
import { Router } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import { env } from "../config/env";
import { HttpError } from "../middleware/errors";
import { requireSharedSecret } from "../middleware/sharedSecret";
import {
  connectLineChannel,
  disconnectLineChannel,
  getLineConnectionSettings,
  type LineConnectionSettings
} from "../services/lineConnectionService";
import { ensureTenantForLocation } from "../services/repository";

type PageAction = "connect" | "disconnect";

type SignedPagePayload = {
  kind: "page_access" | "page_action";
  action?: PageAction;
  locationId: string;
  expiresAt: number;
  nonce: string;
};

type LineTestChatDetails = {
  lineChatUrl: string;
  qrCodeDataUrl: string;
};

const tokenTtlMs = 15 * 60 * 1000;

const pageFormBodyParser = express.urlencoded({ extended: false, limit: "32kb" });
const pageLaunchQuerySchema = z.object({ locationId: z.string().min(1) });
const pageLinkBodySchema = z.object({ locationId: z.string().min(1) });
const pageQuerySchema = z.object({
  locationId: z.string().min(1),
  pageToken: z.string().min(1),
  status: z.string().optional()
});
const pageConnectBodySchema = z.object({
  locationId: z.string().min(1),
  pageToken: z.string().min(1),
  actionToken: z.string().min(1),
  channelAccessToken: z.string().min(1),
  channelSecret: z.string().min(1)
});
const pageDisconnectBodySchema = z.object({
  locationId: z.string().min(1),
  pageToken: z.string().min(1),
  actionToken: z.string().min(1)
});

export const appLinePageRouter = Router();

function getPublicBaseUrl(req: Request): string {
  return env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

function getPageSigningSecret(): string {
  const secret = env.WEBHOOK_SHARED_SECRET.trim();

  if (!secret) {
    throw new HttpError(503, "App page signing secret is not configured");
  }

  return secret;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getReadableError(error: unknown): string {
  if (error instanceof HttpError) {
    return error.message;
  }

  if (error instanceof z.ZodError) {
    return "Please fill in all required fields.";
  }

  return error instanceof Error ? error.message : "Something went wrong.";
}

function signPayload(payloadText: string): string {
  return crypto.createHmac("sha256", getPageSigningSecret()).update(payloadText).digest("base64url");
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createSignedToken(input: {
  kind: SignedPagePayload["kind"];
  locationId: string;
  action?: PageAction;
}): { token: string; expiresAt: string } {
  const expiresAt = Date.now() + tokenTtlMs;
  const payload: SignedPagePayload = {
    kind: input.kind,
    action: input.action,
    locationId: input.locationId,
    expiresAt,
    nonce: crypto.randomBytes(16).toString("hex")
  };
  const payloadText = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

  return {
    token: `${payloadText}.${signPayload(payloadText)}`,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function readSignedToken(token: string, expectedKind: SignedPagePayload["kind"]): SignedPagePayload {
  const [payloadText, signature] = token.split(".");

  if (!payloadText || !signature || !timingSafeStringEqual(signature, signPayload(payloadText))) {
    throw new HttpError(401, "Invalid page token");
  }

  let payload: SignedPagePayload;

  try {
    payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8")) as SignedPagePayload;
  } catch {
    throw new HttpError(401, "Invalid page token");
  }

  if (payload.kind !== expectedKind || payload.expiresAt < Date.now()) {
    throw new HttpError(401, "Invalid page token");
  }

  return payload;
}

function verifyPageAccessToken(token: string, locationId: string): void {
  const payload = readSignedToken(token, "page_access");

  if (payload.locationId !== locationId) {
    throw new HttpError(401, "Invalid page token");
  }
}

function verifyPageActionToken(token: string, locationId: string, action: PageAction): void {
  const payload = readSignedToken(token, "page_action");

  if (payload.locationId !== locationId || payload.action !== action) {
    throw new HttpError(401, "Invalid page action token");
  }
}

function buildPagePath(locationId: string, pageToken: string): string {
  return `/app/line/page?locationId=${encodeURIComponent(
    locationId
  )}&pageToken=${encodeURIComponent(pageToken)}`;
}

function buildPageUrl(req: Request, locationId: string, pageToken: string): string {
  return `${getPublicBaseUrl(req).replace(/\/+$/, "")}${buildPagePath(locationId, pageToken)}`;
}

function removeFrameOptionsHeader(res: Response): void {
  res.removeHeader("X-Frame-Options");
}

function getCustomPageFrameAncestors(): string {
  return env.CUSTOM_PAGE_FRAME_ANCESTORS.split(/\s+/).filter(Boolean).join(" ");
}

function setPageHeaders(res: Response, scriptNonce: string): void {
  removeFrameOptionsHeader(res);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "img-src 'self' data:",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${scriptNonce}'`,
      `frame-ancestors ${getCustomPageFrameAncestors()}`
    ].join("; ")
  );
}

async function renderLinePage(
  req: Request,
  res: Response,
  input: {
    locationId: string;
    pageToken: string;
    statusMessage?: string;
    errorMessage?: string;
  }
): Promise<void> {
  verifyPageAccessToken(input.pageToken, input.locationId);

  const settings = await getLineConnectionSettings({
    locationId: input.locationId,
    publicBaseUrl: getPublicBaseUrl(req)
  });
  const avatarDataUrl = await getLineBotAvatarDataUrl(settings.line_bot_info?.pictureUrl);
  const lineChatUrl = buildLineChatUrl(settings.line_bot_info?.basicId);
  const qrCodeDataUrl = await getLineChatQrCodeDataUrl(lineChatUrl);
  const lineTestChat = lineChatUrl && qrCodeDataUrl ? { lineChatUrl, qrCodeDataUrl } : null;
  const scriptNonce = crypto.randomBytes(16).toString("base64url");

  setPageHeaders(res, scriptNonce);
  res.status(input.errorMessage ? 400 : 200).send(
    buildLinePageHtml({
      ...input,
      settings,
      avatarDataUrl,
      lineTestChat,
      scriptNonce,
      connectActionToken: createSignedToken({
        kind: "page_action",
        locationId: input.locationId,
        action: "connect"
      }).token,
      disconnectActionToken: createSignedToken({
        kind: "page_action",
        locationId: input.locationId,
        action: "disconnect"
      }).token
    })
  );
}

function buildLinePageHtml(input: {
  locationId: string;
  pageToken: string;
  settings: LineConnectionSettings;
  avatarDataUrl: string | null;
  lineTestChat: LineTestChatDetails | null;
  connectActionToken: string;
  disconnectActionToken: string;
  scriptNonce: string;
  statusMessage?: string;
  errorMessage?: string;
}): string {
  const webhookUrl = input.settings.webhook_url ?? "";
  const statusLabel = input.settings.connected ? "Active" : "Not connected";
  const statusClass = input.settings.connected ? "connected" : "disconnected";
  const accountName = input.settings.line_bot_info?.displayName || "Connected LINE Official Account";
  const basicId = input.settings.line_bot_info?.basicId;
  const content = input.settings.connected
    ? buildConnectedView({ ...input, webhookUrl, accountName, basicId })
    : buildNotConnectedView({ ...input, webhookUrl });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LINE Official Account</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--border:#dfe3ea;--text:#162033;--muted:#667085;--line:#06c755;--line-dark:#049746;--danger:#ba1a1a;--danger-bg:#fff1f0;--ok:#edfdf4;--ok-border:#abefc6;--warn:#fffaeb;--warn-border:#fedf89}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body.modal-open{overflow:hidden}main{width:min(920px,calc(100vw - 32px));margin:0 auto;padding:28px 0}[hidden]{display:none!important}.topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}h1,h2,h3,p{margin:0}h1{font-size:28px;line-height:1.15}h2{font-size:18px;margin-bottom:12px}h3{font-size:15px;margin-bottom:8px}.tenant,.help,.small{color:var(--muted);font-size:13px}.tenant{margin-top:6px;word-break:break-all}.pill{border:1px solid var(--border);border-radius:999px;padding:9px 16px;background:#fff;font-size:15px;font-weight:800;white-space:nowrap}.pill.connected{color:#067647;border-color:var(--ok-border);background:var(--ok)}.pill.disconnected{color:#7a4b00;border-color:var(--warn-border);background:var(--warn)}.panel{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:22px;margin-bottom:16px;box-shadow:0 12px 30px rgba(21,28,43,.08)}.success{border-color:var(--ok-border);background:linear-gradient(180deg,#f6fef9,#fff)}.account{display:flex;align-items:center;gap:14px;margin-top:16px;padding:16px;border:1px solid var(--border);border-radius:8px;background:#fff}.account-details{min-width:0;flex:1}.account-actions{display:flex;flex:0 0 auto;margin-left:auto}.avatar{width:48px;height:48px;border-radius:12px;object-fit:cover;border:1px solid var(--border);background:var(--line)}.avatar-fallback{display:grid;place-items:center;color:#fff;font-weight:900;font-size:20px}.account-name{font-size:20px;font-weight:800;word-break:break-word}.account-sub{color:var(--muted);font-size:13px;margin-top:2px}.field{margin-bottom:14px}label{display:block;color:#344054;font-weight:700;font-size:13px;margin-bottom:6px}input,textarea{width:100%;border:1px solid var(--border);border-radius:8px;padding:11px 12px;font:inherit;color:var(--text);background:#fff}textarea{min-height:120px;resize:vertical}input[readonly]{background:#f9fafb}.inline{display:flex;gap:10px}.inline input{min-width:0}.actions,.modal-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}.modal-actions{justify-content:center;margin-top:18px}button,.button-like{border:0;border-radius:8px;padding:10px 14px;min-height:42px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}.primary{background:var(--line);color:#fff}.primary:hover{background:var(--line-dark)}.secondary{background:#eef2f6;color:var(--text)}.danger{background:var(--danger);color:#fff}button:disabled{cursor:not-allowed;opacity:.55}.notice,.error{border-radius:8px;padding:12px 14px;margin-bottom:16px}.notice{border:1px solid var(--ok-border);background:var(--ok);color:#05603a}.error{border:1px solid #fecdca;background:var(--danger-bg);color:var(--danger)}.intro{font-size:16px;margin-bottom:16px}.steps,.checks{margin:0;padding-left:22px}.steps li,.checks li{margin:8px 0}.admin-note{margin-bottom:16px}.spaced{margin-top:14px}.modal-backdrop{position:fixed;inset:0;z-index:20;display:grid;place-items:center;padding:24px;background:rgba(16,24,40,.6)}.modal{position:relative;width:min(460px,100%);border:1px solid var(--border);border-radius:8px;background:#fff;padding:24px;text-align:center;box-shadow:0 24px 60px rgba(21,28,43,.28)}.modal h2{font-size:22px;margin:0 42px 8px}.modal-close{position:absolute;right:14px;top:14px;width:36px;min-height:36px;padding:0;font-size:24px;line-height:1}.qr-code{display:block;width:min(300px,100%);height:auto;margin:18px auto 14px;padding:10px;border:1px solid var(--border);border-radius:8px;background:#fff}.chat-link-display{display:block;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:#f9fafb;color:var(--text);font-size:13px;font-weight:700;text-decoration:none;word-break:break-all}@media(max-width:720px){main{width:min(100vw - 24px,920px);padding:20px 0}.topbar{flex-direction:column}.inline{flex-direction:column}.account{align-items:flex-start;flex-wrap:wrap}.account-actions{width:100%;margin-left:0}.test-chat-button,.modal-actions>*{width:100%}.pill{font-size:14px}.modal{padding:22px 18px}.modal-actions{flex-direction:column}}
</style>
</head>
<body>
<main>
  <div class="topbar">
    <div><h1>LINE Official Account</h1><div class="tenant">Location ${escapeHtml(input.locationId)}</div></div>
    <span class="pill ${statusClass}">${statusLabel}</span>
  </div>
  ${input.statusMessage ? `<div class="notice">${escapeHtml(input.statusMessage)}</div>` : ""}
  ${input.errorMessage ? `<div class="error">${escapeHtml(input.errorMessage)}</div>` : ""}
  ${content}
</main>
<script nonce="${input.scriptNonce}">
const copyButton=document.getElementById("copy-webhook");
const webhookInput=document.getElementById("webhook-url");
copyButton?.addEventListener("click",async()=>{if(!webhookInput?.value)return;try{await navigator.clipboard.writeText(webhookInput.value)}catch{webhookInput.select();document.execCommand("copy")}copyButton.textContent="Copied";window.setTimeout(()=>{copyButton.textContent="Copy"},1500)});
const testChatModal=document.getElementById("test-chat-modal");
const openTestChatButton=document.getElementById("open-test-chat");
const closeTestChatButton=document.getElementById("close-test-chat");
const copyChatLinkButton=document.getElementById("copy-chat-link");
const lineChatUrl=copyChatLinkButton?.getAttribute("data-chat-link")||"";
function setTestChatModalOpen(isOpen){if(!testChatModal)return;testChatModal.hidden=!isOpen;document.body.classList.toggle("modal-open",isOpen);if(isOpen){closeTestChatButton?.focus()}else{openTestChatButton?.focus()}}
openTestChatButton?.addEventListener("click",()=>setTestChatModalOpen(true));
closeTestChatButton?.addEventListener("click",()=>setTestChatModalOpen(false));
testChatModal?.addEventListener("click",(event)=>{if(event.target===testChatModal)setTestChatModalOpen(false)});
document.addEventListener("keydown",(event)=>{if(event.key==="Escape"&&testChatModal&&!testChatModal.hidden)setTestChatModalOpen(false)});
copyChatLinkButton?.addEventListener("click",async()=>{if(!lineChatUrl)return;try{await navigator.clipboard.writeText(lineChatUrl)}catch{const textArea=document.createElement("textarea");textArea.value=lineChatUrl;textArea.style.position="fixed";textArea.style.left="-9999px";document.body.appendChild(textArea);textArea.focus();textArea.select();document.execCommand("copy");textArea.remove()}copyChatLinkButton.textContent="Copied";window.setTimeout(()=>{copyChatLinkButton.textContent="Copy link"},1500)});
</script>
</body>
</html>`;
}

function buildLineChatUrl(basicId: string | null | undefined): string | null {
  const trimmedBasicId = basicId?.trim();

  if (!trimmedBasicId) {
    return null;
  }

  const safeBasicId = /^[A-Za-z0-9@._-]+$/.test(trimmedBasicId)
    ? trimmedBasicId
    : encodeURIComponent(trimmedBasicId);

  return `https://line.me/R/ti/p/${safeBasicId}`;
}

async function getLineChatQrCodeDataUrl(lineChatUrl: string | null): Promise<string | null> {
  if (!lineChatUrl) {
    return null;
  }

  try {
    return await QRCode.toDataURL(lineChatUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
      color: {
        dark: "#162033",
        light: "#ffffff"
      }
    });
  } catch {
    return null;
  }
}

function getSafeHttpUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsedUrl = new URL(value);
    return ["http:", "https:"].includes(parsedUrl.protocol) ? parsedUrl.toString() : null;
  } catch {
    return null;
  }
}

async function getLineBotAvatarDataUrl(pictureUrl: string | null | undefined): Promise<string | null> {
  const safeUrl = getSafeHttpUrl(pictureUrl);

  if (!safeUrl) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  const maxAvatarBytes = 256 * 1024;

  try {
    const response = await fetch(safeUrl, { signal: controller.signal });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

    if (!contentType || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(contentType)) {
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);

    if (contentLength > maxAvatarBytes) {
      return null;
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());

    if (imageBuffer.byteLength > maxAvatarBytes) {
      return null;
    }

    return `data:${contentType};base64,${imageBuffer.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildWebhookPanel(webhookUrl: string): string {
  return `<section class="panel">
    <h2>Webhook URL</h2>
    <div class="inline">
      <input id="webhook-url" readonly value="${escapeHtml(webhookUrl)}" placeholder="Connect LINE to generate a webhook URL">
      <button class="secondary" type="button" id="copy-webhook" ${webhookUrl ? "" : "disabled"}>Copy</button>
    </div>
    <p class="help spaced">Paste this URL into LINE Developers as the Messaging API webhook URL.</p>
  </section>`;
}

function buildConnectedView(input: {
  locationId: string;
  pageToken: string;
  settings: LineConnectionSettings;
  disconnectActionToken: string;
  webhookUrl: string;
  accountName: string;
  basicId?: string | null;
  avatarDataUrl: string | null;
  lineTestChat: LineTestChatDetails | null;
}): string {
  return `${buildConnectedAccountPanel(input)}
  ${input.lineTestChat ? buildTestChatModal(input.lineTestChat) : ""}
  ${buildWebhookPanel(input.webhookUrl)}
  ${buildDisconnectPanel(input)}`;
}

function buildConnectedAccountPanel(input: {
  accountName: string;
  basicId?: string | null;
  avatarDataUrl: string | null;
  lineTestChat: LineTestChatDetails | null;
}): string {
  const avatar = input.avatarDataUrl
    ? `<img class="avatar" src="${escapeHtml(input.avatarDataUrl)}" alt="">`
    : `<div class="avatar avatar-fallback" aria-hidden="true">L</div>`;
  const basicId = input.basicId ? `<div class="account-sub">${escapeHtml(input.basicId)}</div>` : "";
  const testChatButton = input.lineTestChat
    ? `<div class="account-actions"><button class="secondary test-chat-button" type="button" id="open-test-chat">Test Chat</button></div>`
    : "";

  return `<section class="panel success">
    <h2>Active</h2>
    <p class="intro">Your LINE Official Account is connected to this Win-CRM.ai account.</p>
    <div class="account">
      ${avatar}
      <div class="account-details">
        <div class="small">Connected account</div>
        <div class="account-name">${escapeHtml(input.accountName)}</div>
        ${basicId}
      </div>
      ${testChatButton}
    </div>
  </section>`;
}

function buildTestChatModal(input: LineTestChatDetails): string {
  return `<div class="modal-backdrop" id="test-chat-modal" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="test-chat-title">
      <button class="secondary modal-close" type="button" id="close-test-chat" aria-label="Close">&times;</button>
      <h2 id="test-chat-title">LINE QR Code</h2>
      <p class="help">Scan this QR code to start a conversation.</p>
      <img class="qr-code" src="${escapeHtml(input.qrCodeDataUrl)}" alt="LINE chat QR code">
      <a class="chat-link-display" href="${escapeHtml(input.lineChatUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        input.lineChatUrl
      )}</a>
      <div class="modal-actions">
        <button class="secondary" type="button" id="copy-chat-link" data-chat-link="${escapeHtml(
          input.lineChatUrl
        )}">Copy link</button>
        <a class="button-like secondary" href="${escapeHtml(
          input.qrCodeDataUrl
        )}" download="line-qr-code.png">Download QR Code</a>
        <a class="button-like primary" href="${escapeHtml(
          input.lineChatUrl
        )}" target="_blank" rel="noopener noreferrer">Chat on LINE</a>
      </div>
    </div>
  </div>`;
}

function buildDisconnectPanel(input: {
  locationId: string;
  pageToken: string;
  disconnectActionToken: string;
  settings: LineConnectionSettings;
}): string {
  return `<section class="panel">
    <form method="post" action="/app/line/page/disconnect">
      <input type="hidden" name="locationId" value="${escapeHtml(input.locationId)}">
      <input type="hidden" name="pageToken" value="${escapeHtml(input.pageToken)}">
      <input type="hidden" name="actionToken" value="${escapeHtml(input.disconnectActionToken)}">
      <div class="actions"><button class="danger" type="submit" ${input.settings.connected ? "" : "disabled"}>Disconnect LINE</button></div>
    </form>
  </section>`;
}

function buildNotConnectedView(input: {
  locationId: string;
  pageToken: string;
  connectActionToken: string;
  webhookUrl: string;
}): string {
  return `<section class="panel">
    <h2>Not connected</h2>
    <p class="intro">Connect your LINE Official Account to send and receive LINE messages inside Win-CRM.ai.</p>
  </section>
  ${buildSetupGuidePanel()}
  ${buildAdminSetupPanel(input)}
  ${buildWebhookPanel(input.webhookUrl)}`;
}

function buildSetupGuidePanel(): string {
  return `<section class="panel">
    <h2>Setup guide</h2>
    <ol class="steps">
      <li>Open LINE Official Account Manager.</li>
      <li>Go to Settings &gt; Messaging API.</li>
      <li>Open LINE Developers Console.</li>
      <li>Copy the Channel secret.</li>
      <li>Go to Messaging API tab and copy the Channel access token.</li>
      <li>Paste both values into Admin setup and click Connect LINE.</li>
      <li>Copy the Webhook URL from this page.</li>
      <li>Paste it into LINE Developers &gt; Messaging API &gt; Webhook URL.</li>
      <li>Turn ON "Use webhook".</li>
      <li>Send a test message from LINE and confirm it appears in your conversation inbox.</li>
    </ol>
  </section>`;
}

function buildAdminSetupPanel(input: {
  locationId: string;
  pageToken: string;
  connectActionToken: string;
}): string {
  return `<section class="panel">
    <h2>Admin setup</h2>
    <p class="help admin-note">Paste the Channel access token and Channel secret from LINE Developers Console.</p>
    <form method="post" action="/app/line/page/connect" autocomplete="off">
      <input type="hidden" name="locationId" value="${escapeHtml(input.locationId)}">
      <input type="hidden" name="pageToken" value="${escapeHtml(input.pageToken)}">
      <input type="hidden" name="actionToken" value="${escapeHtml(input.connectActionToken)}">
      <div class="field"><label for="channel-access-token">Channel access token</label><textarea id="channel-access-token" name="channelAccessToken" required spellcheck="false" autocomplete="off"></textarea></div>
      <div class="field"><label for="channel-secret">Channel secret</label><input id="channel-secret" name="channelSecret" type="password" required autocomplete="off"></div>
      <div class="actions"><button class="primary" type="submit">Connect LINE</button></div>
    </form>
  </section>`;
}

appLinePageRouter.post("/app/line/page-link", requireSharedSecret, async (req, res, next) => {
  try {
    const input = pageLinkBodySchema.parse(req.body);
    await ensureTenantForLocation(input.locationId);

    const { token, expiresAt } = createSignedToken({ kind: "page_access", locationId: input.locationId });

    res.json({
      page_url: buildPageUrl(req, input.locationId, token),
      expires_at: expiresAt
    });
  } catch (error) {
    next(error);
  }
});

appLinePageRouter.get("/app/line/launch", async (req, res, next) => {
  try {
    const query = pageLaunchQuerySchema.parse(req.query);
    const { token } = createSignedToken({ kind: "page_access", locationId: query.locationId });

    removeFrameOptionsHeader(res);
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, buildPagePath(query.locationId, token));
  } catch (error) {
    next(error);
  }
});

appLinePageRouter.get("/app/line/page", async (req, res, next) => {
  try {
    const query = pageQuerySchema.parse(req.query);

    await renderLinePage(req, res, {
      locationId: query.locationId,
      pageToken: query.pageToken,
      statusMessage: query.status
    });
  } catch (error) {
    next(error);
  }
});

appLinePageRouter.post("/app/line/page/connect", pageFormBodyParser, async (req, res, next) => {
  try {
    const input = pageConnectBodySchema.parse(req.body);
    verifyPageAccessToken(input.pageToken, input.locationId);
    verifyPageActionToken(input.actionToken, input.locationId, "connect");

    await connectLineChannel({
      locationId: input.locationId,
      channelAccessToken: input.channelAccessToken,
      channelSecret: input.channelSecret,
      publicBaseUrl: getPublicBaseUrl(req)
    });

    const { token } = createSignedToken({ kind: "page_access", locationId: input.locationId });
    res.redirect(303, `${buildPageUrl(req, input.locationId, token)}&status=LINE%20connected`);
  } catch (error) {
    try {
      const locationId = typeof req.body?.locationId === "string" && req.body.locationId.trim() ? req.body.locationId : "";
      const pageToken = typeof req.body?.pageToken === "string" ? req.body.pageToken : "";

      await renderLinePage(req, res, { locationId, pageToken, errorMessage: getReadableError(error) });
    } catch (renderError) {
      next(renderError);
    }
  }
});

appLinePageRouter.post("/app/line/page/disconnect", pageFormBodyParser, async (req, res, next) => {
  try {
    const input = pageDisconnectBodySchema.parse(req.body);
    verifyPageAccessToken(input.pageToken, input.locationId);
    verifyPageActionToken(input.actionToken, input.locationId, "disconnect");

    await disconnectLineChannel({
      locationId: input.locationId,
      publicBaseUrl: getPublicBaseUrl(req)
    });

    const { token } = createSignedToken({ kind: "page_access", locationId: input.locationId });
    res.redirect(303, `${buildPageUrl(req, input.locationId, token)}&status=LINE%20disconnected`);
  } catch (error) {
    try {
      const locationId = typeof req.body?.locationId === "string" && req.body.locationId.trim() ? req.body.locationId : "";
      const pageToken = typeof req.body?.pageToken === "string" ? req.body.pageToken : "";

      await renderLinePage(req, res, { locationId, pageToken, errorMessage: getReadableError(error) });
    } catch (renderError) {
      next(renderError);
    }
  }
});
