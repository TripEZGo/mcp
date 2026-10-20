#!/usr/bin/env node

// src/cli.ts
import { homedir as homedir2 } from "node:os";
import { join as join6 } from "node:path";

// src/phoneTransport.ts
import { createHmac } from "node:crypto";
import { Agent, request } from "node:https";
var PSK_CIPHER = "PSK-AES128-GCM-SHA256";
var PSK_IDENTITY = "tripezgo";
var PSK_CONTEXT = "tripezgo tls psk v1";
function derivePsk(connectionKey) {
  return createHmac("sha256", Buffer.from(connectionKey, "utf8")).update(PSK_CONTEXT, "utf8").digest();
}
function pskClientOptions(connectionKey) {
  const psk = derivePsk(connectionKey);
  return {
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    ciphers: PSK_CIPHER,
    pskCallback: () => ({ psk, identity: PSK_IDENTITY })
  };
}
var TlsHandshakeError = class extends Error {
  constructor(cause) {
    super(`TLS handshake failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "TlsHandshakeError";
  }
};
var agents = /* @__PURE__ */ new Map();
function agentFor(connectionKey) {
  let agent = agents.get(connectionKey);
  if (!agent) {
    agent = new Agent({
      keepAlive: true,
      ...pskClientOptions(connectionKey),
      // PSK mode has no certificate to check; the shared key is the authentication.
      checkServerIdentity: () => void 0
    });
    agents.set(connectionKey, agent);
  }
  return agent;
}
var phoneFetch = ((input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init.headers);
  const key = /^Bearer (.*)$/.exec(headers.get("authorization") ?? "")?.[1];
  if (key === void 0) return Promise.reject(new TypeError("phoneFetch needs the connection key as a Bearer token"));
  const signal = init.signal ?? void 0;
  const body = init.body === void 0 || init.body === null ? void 0 : typeof init.body === "string" ? init.body : Buffer.from(init.body);
  return new Promise((resolve3, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    let tcpUp = false;
    let secured = false;
    const outHeaders = {};
    headers.forEach((value, name) => outHeaders[name] = value);
    const req = request(
      {
        host: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: outHeaders,
        agent: agentFor(key),
        servername: ""
        // an IP literal; no SNI
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(name, v));
            else if (value !== void 0) responseHeaders.set(name, value);
          }
          const status = res.statusCode ?? 0;
          const empty = status === 204 || status === 205 || status === 304;
          resolve3(new Response(empty ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
        });
      }
    );
    req.on("socket", (socket) => {
      if (!socket.connecting) {
        tcpUp = true;
        secured = true;
        return;
      }
      socket.once("connect", () => tcpUp = true);
      socket.once("secureConnect", () => secured = true);
    });
    req.on("error", (error) => {
      if (signal?.aborted) return reject(signal.reason);
      reject(tcpUp && !secured ? new TlsHandshakeError(error) : error);
    });
    signal?.addEventListener("abort", () => req.destroy(), { once: true });
    req.end(body);
  });
});

// src/messages.ts
function unreachableMessage(baseUrl, cause, wording = "command") {
  if (cause instanceof TlsHandshakeError) return tlsHandshakeMessage(baseUrl, cause, wording);
  const detail = cause instanceof Error ? describeCause(cause) : String(cause);
  return `Can't reach the TripEZGo app at ${baseUrl} (${detail}). On the iPhone, keep the "Connect computer AI" page (\u9023\u63A5\u96FB\u8166 AI) open with TripEZGo in the foreground, and make sure the phone and this computer are on the same Wi-Fi.` + (wording === "sentence" ? " If that page now shows a different address or a new connect sentence (the Wi-Fi changed, or the page was reopened), ask the user to copy the latest connect sentence from the iPhone and paste it again, then call `connect` with it." : "");
}
function tlsHandshakeMessage(baseUrl, cause, wording = "command") {
  return `Couldn't set up the encrypted connection to the TripEZGo app at ${baseUrl} (${describeCause(cause)}). Either TripEZGo on the iPhone is too old for this bridge (the bridge only talks TLS with a key-derived secret, never plain HTTP), or the key is wrong. Ask the user to update TripEZGo from the App Store, reopen the "Connect computer AI" page (\u9023\u63A5\u96FB\u8166 AI), and ` + (wording === "sentence" ? "paste the fresh connect sentence it shows, then call `connect` again." : "copy the new command.");
}
function unauthorizedMessage() {
  return 'The TripEZGo app rejected the token (HTTP 401). The token only works while the "Connect computer AI" page that made it stays open; if you closed it, open the page again and copy the new command.';
}
function apiLevelMismatchMessage(appMessage) {
  return "The TripEZGo app and this bridge (github:TripEZGo/mcp) speak different versions of the upload API" + (appMessage ? ` \u2014 the app says: ${appMessage}` : "") + ". Update TripEZGo from the App Store, and restart the AI app so the bridge updates itself (an install from before 0.2.0: run `npx -y github:TripEZGo/mcp install <claude-code|codex|claude-desktop>`), then try again.";
}
var CONNECT_HOWTO = 'Ask the user to open TripEZGo on their iPhone, go to the "Connect computer AI" page (\u9023\u63A5\u96FB\u8166 AI \u2014 Settings \u203A \u7528\u96FB\u8166 AI \u7DE8\u8F2F, or New trip \u203A \u7528\u96FB\u8166 AI \u5EFA\u7ACB\u65C5\u7A0B), keep it open, and paste the connect sentence it shows; it looks like \u300C\u9023\u63A5 TripEZGo\uFF1A192.168.1.23:8765\uFF0C\u91D1\u9470 abc123\u300D. Then call `connect` with the address and the key from that sentence.';
function notConnectedMessage(tool) {
  return `Not connected to the TripEZGo app yet, so ${tool} can't run. ${CONNECT_HOWTO} After that, call ${tool} again.`;
}
function connectUnauthorizedMessage() {
  return 'The TripEZGo app rejected that key (HTTP 401). A key only works while the "Connect computer AI" page that showed it stays open; reopening the page makes a new one. Ask the user to open the page and paste the connect sentence it shows now, then call `connect` again.';
}
function connectionLostMessage(status) {
  return `The TripEZGo app no longer accepts this connection (HTTP ${status}): the "Connect computer AI" page was closed or reopened, and that ends the old key. Ask the user to open the page on the iPhone and paste the connect sentence it shows now, then call \`connect\` again.`;
}
function unsupportedToolMessage(tool, appVersion) {
  return `The TripEZGo app on the iPhone${appVersion ? ` (version ${appVersion})` : ""} doesn't have ${tool} yet. Ask the user to update TripEZGo from the App Store, reopen the "Connect computer AI" page, and paste the new connect sentence; then call \`connect\` again and retry.`;
}
function describeCause(error) {
  if (error instanceof TlsHandshakeError) return error.cause?.message ?? error.message;
  if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const { code, message } = cause;
    if (code) return String(code);
    if (message) return String(message);
  }
  return error.message;
}

// src/protocol.ts
var ErrorCode = {
  ConnectionClosed: -32e3,
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603
};
function errorLine(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}
function resultLine(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function toolFailure(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}
function toolText(text) {
  return { content: [{ type: "text", text }] };
}
function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function hasId(message) {
  return "id" in message && message.id !== void 0;
}
function hasCursor(request2) {
  return isObject(request2.params) && request2.params.cursor !== void 0;
}
function isJsonRpc(body) {
  try {
    const value = JSON.parse(body);
    return Array.isArray(value) || isObject(value) && value.jsonrpc === "2.0";
  } catch {
    return false;
  }
}
function sseData(text) {
  const out = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (data.trim() !== "") out.push(data);
  }
  return out;
}
function rpcBodies(text, contentType) {
  if (contentType.includes("text/event-stream")) return sseData(text);
  return text.trim() === "" ? [] : [text];
}

// src/upload.ts
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

// src/mime.ts
import { extname } from "node:path";
var TYPES = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".rtf": "application/rtf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pages": "application/vnd.apple.pages",
  ".numbers": "application/vnd.apple.numbers",
  ".key": "application/vnd.apple.keynote",
  ".zip": "application/zip",
  ".ics": "text/calendar",
  ".gpx": "application/gpx+xml",
  ".kml": "application/vnd.google-earth.kml+xml",
  ".pkpass": "application/vnd.apple.pkpass",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime"
};
function mimeTypeFor(fileName) {
  return TYPES[extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

// src/upload.ts
var API_LEVEL = 1;
var DEFAULT_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
var UPLOAD_LIMIT_META_KEY = "tripezgo/uploadLimitBytes";
var LOCAL_TOOL_NAME = "add_attachment_from_path";
function uploadLimitFrom(initializeResult) {
  if (!initializeResult || typeof initializeResult !== "object") return void 0;
  const meta = initializeResult._meta;
  if (!meta || typeof meta !== "object") return void 0;
  const value = meta[UPLOAD_LIMIT_META_KEY];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
function localTool(maxBytes = DEFAULT_UPLOAD_LIMIT_BYTES) {
  return {
    name: LOCAL_TOOL_NAME,
    title: "Attach a file from this computer",
    description: `Attach a file that is on this computer to a TripEZGo trip or event (up to ${formatMB(maxBytes)}). The file is read here and uploaded to the app. Without eventId the file is attached to the trip itself; without tripId the app's default trip is used. Prefer this over add_attachment for any file on disk.`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path of the file on this computer. Absolute, ~/\u2026, or relative to the bridge's working directory."
        },
        tripId: { type: "string", description: "Trip id from list_trips. Defaults to the app's default trip." },
        eventId: { type: "string", description: "Event id from list_events. Omit to attach to the trip." },
        name: { type: "string", description: "File name to show in the app. Defaults to the file's own name." }
      },
      required: ["path"]
    }
  };
}
async function addAttachmentFromPath(args, options) {
  const input = args && typeof args === "object" ? args : {};
  const rawPath = input.path;
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return failure("`path` is required: the path of the file on this computer.");
  }
  const requested = expandPath(rawPath.trim());
  let filePath;
  try {
    filePath = await realpath(requested);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) return failure(`Can't read ${requested}: ${error.message}`);
    const refusal2 = await sensitivePathRefusal(requested);
    return failure(refusal2 ?? `No file at ${requested}.`);
  }
  const refusal = await sensitivePathRefusal(filePath);
  if (refusal) return failure(refusal);
  let size;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return failure(`${filePath} is not a file.`);
    size = info.size;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return failure(`No file at ${filePath}.`);
    return failure(`Can't read ${filePath}: ${error.message}`);
  }
  const maxBytes = options.maxBytes ?? DEFAULT_UPLOAD_LIMIT_BYTES;
  if (size > maxBytes) {
    return failure(`${filePath} is ${formatMB(size)}; TripEZGo attachments are limited to ${formatMB(maxBytes)}.`);
  }
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    return failure(`Can't read ${filePath}: ${error.message}`);
  }
  const name = typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim() : basename(filePath);
  const query = new URLSearchParams();
  if (typeof input.tripId === "string" && input.tripId !== "") query.set("tripId", input.tripId);
  if (typeof input.eventId === "string" && input.eventId !== "") query.set("eventId", input.eventId);
  query.set("name", name);
  const doFetch = options.fetch ?? phoneFetch;
  let response;
  try {
    response = await doFetch(`${options.baseUrl}/upload?${query.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        "X-TripEZGo-Api-Level": String(API_LEVEL),
        "Content-Type": mimeTypeFor(filePath)
      },
      body: bytes,
      signal: AbortSignal.timeout(options.timeoutMs ?? 3e5)
    });
  } catch (error) {
    return failure(unreachableMessage(options.baseUrl, error, options.wording));
  }
  const text = await response.text();
  const json = parseObject(text);
  if (response.status === 409) return failure(apiLevelMismatchMessage(errorText(json)));
  if (response.status === 401) {
    options.onUnauthorized?.();
    return failure(options.unauthorizedMessage ?? unauthorizedMessage());
  }
  if (!response.ok) {
    return failure(`The TripEZGo app refused the upload (HTTP ${response.status}): ${errorText(json) ?? (text.trim() || "no details")}`);
  }
  const attachmentId = json?.attachmentId;
  const shownName = typeof json?.name === "string" ? json.name : name;
  const byteCount = typeof json?.byteCount === "number" ? json.byteCount : size;
  return {
    content: [
      {
        type: "text",
        text: `Attached "${shownName}" (${byteCount} bytes) as attachment ${String(attachmentId)}.
${text.trim()}`
      }
    ],
    ...json ? { structuredContent: json } : {}
  };
}
function failure(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}
var SENSITIVE_HOME_FOLDERS = [".ssh", ".aws", ".gnupg", ".config", join("Library", "Keychains")];
var WHY = "Hidden files and folders and credential stores (~/.ssh, ~/.aws, ~/.gnupg, ~/.config, ~/Library/Keychains) hold keys, tokens and passwords, so add_attachment_from_path never reads them: an AI that was tricked by text in a web page, file or tool result could otherwise upload them to the phone. If the user really wants this file attached, they can copy it to an ordinary folder themselves and give that path.";
async function sensitivePathRefusal(path) {
  const hidden = path.split(sep).find((part) => part.startsWith(".") && part !== "." && part !== "..");
  if (hidden) return `Refusing to read ${path}: "${hidden}" is a hidden (dot) file or folder. ${WHY}`;
  const homes = /* @__PURE__ */ new Set([homedir()]);
  try {
    homes.add(await realpath(homedir()));
  } catch {
  }
  const fold = (value) => process.platform === "darwin" || process.platform === "win32" ? value.toLowerCase() : value;
  for (const home of homes) {
    for (const folder of SENSITIVE_HOME_FOLDERS) {
      const guarded = join(home, folder);
      if (fold(path) === fold(guarded) || fold(path).startsWith(fold(guarded) + sep)) {
        return `Refusing to read ${path}: it is inside ~/${folder.split(sep).join("/")}. ${WHY}`;
      }
    }
  }
  return void 0;
}
function expandPath(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}
function isErrno(error, code) {
  return !!error && typeof error === "object" && error.code === code;
}
function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}
function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  } catch {
    return void 0;
  }
}
function errorText(json) {
  return typeof json?.error === "string" ? json.error : void 0;
}

// src/bridge.ts
var Bridge = class {
  constructor(options) {
    this.options = options;
  }
  sessionId;
  protocolVersion;
  /** The app's `_meta["tripezgo/uploadLimitBytes"]` from `initialize`; the default until it says. */
  uploadLimitBytes = DEFAULT_UPLOAD_LIMIT_BYTES;
  async handle(line) {
    const raw = line.trim();
    if (raw === "") return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [errorLine(null, ErrorCode.ParseError, "Parse error: stdin line is not JSON")];
    }
    const message = isObject(parsed) ? parsed : void 0;
    if (message?.method === "tools/call" && isObject(message.params) && message.params.name === LOCAL_TOOL_NAME) {
      if (!hasId(message)) return [];
      const result = await addAttachmentFromPath(message.params.arguments, {
        baseUrl: this.options.baseUrl,
        token: this.options.token,
        fetch: this.options.fetch,
        timeoutMs: this.options.uploadTimeoutMs,
        maxBytes: this.uploadLimitBytes
      });
      return [JSON.stringify({ jsonrpc: "2.0", id: message.id, result })];
    }
    return this.forward(raw, message);
  }
  async forward(raw, message) {
    const isRequest = !!message && typeof message.method === "string" && hasId(message);
    const id = isRequest ? message.id : null;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.options.token}`
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
    let response;
    try {
      response = await (this.options.fetch ?? phoneFetch)(`${this.options.baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: raw,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 6e4)
      });
    } catch (error) {
      const text2 = unreachableMessage(this.options.baseUrl, error);
      if (isRequest) return [errorLine(id, ErrorCode.ConnectionClosed, text2)];
      this.options.log?.(text2);
      return [];
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (response.status === 202) return [];
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const bodies = contentType.includes("text/event-stream") ? sseData(text) : text.trim() === "" ? [] : [text];
    if (!response.ok) {
      const rpc = bodies.filter((body) => isJsonRpc(body));
      if (rpc.length > 0) return rpc.map((body) => this.passBack(body, message));
      if (!isRequest) {
        this.options.log?.(`TripEZGo app answered HTTP ${response.status} to a notification: ${text.trim()}`);
        return [];
      }
      if (response.status === 401) return [errorLine(id, ErrorCode.ConnectionClosed, unauthorizedMessage())];
      return [
        errorLine(id, ErrorCode.InternalError, `TripEZGo app answered HTTP ${response.status}: ${text.trim() || "no body"}`)
      ];
    }
    return bodies.map((body) => this.passBack(body, message));
  }
  /** The app's answer, unchanged unless it is the `tools/list` result or has to be squeezed onto one line. */
  passBack(body, request2) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return body.replace(/\r?\n/g, " ");
    }
    if (isObject(parsed) && isObject(parsed.result)) {
      if (request2?.method === "initialize") {
        if (typeof parsed.result.protocolVersion === "string") this.protocolVersion = parsed.result.protocolVersion;
        this.uploadLimitBytes = uploadLimitFrom(parsed.result) ?? DEFAULT_UPLOAD_LIMIT_BYTES;
      }
      if (request2?.method === "tools/list" && !hasCursor(request2) && Array.isArray(parsed.result.tools)) {
        if (!parsed.result.tools.some((tool) => isObject(tool) && tool.name === LOCAL_TOOL_NAME)) {
          parsed.result.tools.push(localTool(this.uploadLimitBytes));
        }
        return JSON.stringify(parsed);
      }
    }
    return /[\r\n]/.test(body) ? JSON.stringify(parsed) : body.trim();
  }
};

// src/config.ts
var USAGE = `Usage:
  npx -y github:TripEZGo/mcp install <claude-code|codex|claude-desktop>
      Install the TripEZGo MCP server and planning skill once; it updates itself.
  tripezgo-mcp
      Run the bridge on stdio. The AI connects with the sentence the iPhone shows
      (\u9023\u63A5 TripEZGo\uFF1AIP:PORT\uFF0C\u91D1\u9470 TOKEN) through the connect tool.
  TRIPEZGO_URL=http://IP:PORT TRIPEZGO_TOKEN=TOKEN npx -y github:TripEZGo/mcp
      Older app versions: bridge to one address and token, shown on the TripEZGo
      "Connect computer AI" page.
  npx -y github:TripEZGo/mcp --url http://IP:PORT --token=TOKEN
      Deprecated: --token puts the key in the process list for every user of this
      computer to read. Use TRIPEZGO_TOKEN instead.`;
var ConfigError = class extends Error {
};
var KNOWN_FLAGS = ["url", "token"];
function isKnownFlag(arg) {
  return KNOWN_FLAGS.some((name) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}
function parseConfig(argv2, env, warn) {
  const flags = /* @__PURE__ */ new Map();
  const set = (name, value) => {
    if (flags.has(name)) throw new ConfigError(`--${name} given more than once`);
    flags.set(name, value);
  };
  for (let i = 0; i < argv2.length; i++) {
    const arg = argv2[i];
    if (!arg.startsWith("--")) {
      throw new ConfigError(`Unexpected argument: ${arg}`);
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const value = argv2[i + 1];
    if (value === void 0 || isKnownFlag(value)) {
      throw new ConfigError(`${arg} needs a value`);
    }
    set(arg.slice(2), value);
    i++;
  }
  for (const key of flags.keys()) {
    if (key !== "url" && key !== "token") {
      throw new ConfigError(`Unknown option: --${key}`);
    }
  }
  if (flags.has("token")) {
    warn?.("--token is deprecated: a command-line argument is visible in the process list. Set TRIPEZGO_TOKEN instead.");
  }
  const rawUrl = (flags.get("url") ?? env.TRIPEZGO_URL ?? "").trim();
  const token = (flags.get("token") ?? env.TRIPEZGO_TOKEN ?? "").trim();
  if (!rawUrl && !token) return void 0;
  if (!rawUrl) throw new ConfigError("Missing --url (or TRIPEZGO_URL)");
  if (!token) throw new ConfigError("Missing --token (or TRIPEZGO_TOKEN)");
  assertPrivateAddress(rawUrl);
  return { baseUrl: normalizeBaseUrl(rawUrl), token };
}
function normalizeBaseUrl(raw) {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ConfigError(`Not a valid URL: ${raw}`);
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  return `${url.protocol}//${url.host}${path}`;
}
var PRIVATE_RANGES_TEXT = "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, or Tailscale 100.64.0.0/10";
function parseIPv4Literal(host) {
  const match = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(host);
  if (!match) return void 0;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : void 0;
}
function isPrivateIPv4([a, b], allowLoopback) {
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || a === 100 && b >= 64 && b <= 127 || allowLoopback && a === 127;
}
function assertPrivateAddress(raw, options = {}) {
  const reject = (why) => {
    throw new ConfigError(
      `${why}. TripEZGo connects only to a literal IPv4 address on a private network (${PRIVATE_RANGES_TEXT}), the one the iPhone shows; hostnames and public addresses are refused on purpose`
    );
  };
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]*)([/?#].*)?$/i.exec(raw.trim());
  if (!match) return reject(`Not a usable address: ${raw}`);
  const [, scheme, authority] = match;
  if (scheme && !/^https?$/i.test(scheme)) return reject(`Not an http(s) address: ${raw}`);
  if (authority.includes("@") || authority.includes("[")) return reject(`Not a plain IPv4 address: ${raw}`);
  const colon = authority.lastIndexOf(":");
  const host = colon === -1 ? authority : authority.slice(0, colon);
  const port = colon === -1 ? "" : authority.slice(colon + 1);
  if (port !== "" && !/^\d{1,5}$/.test(port)) return reject(`Not a valid port in ${raw}`);
  const octets = parseIPv4Literal(host);
  if (!octets) return reject(`"${host}" is a hostname or not a plain IPv4 address`);
  if (!isPrivateIPv4(octets, options.allowLoopback === true)) return reject(`${host} is not a private network address`);
}

// src/guide.ts
import { readFileSync, readdirSync } from "node:fs";
import { join as join2 } from "node:path";
function loadGuide(skillDir) {
  let skill;
  try {
    skill = stripFrontMatter(readFileSync(join2(skillDir, "SKILL.md"), "utf8")).trim();
  } catch {
    return emptyGuide(`The planning guide is missing from this install (${skillDir}).`);
  }
  const references = /* @__PURE__ */ new Map();
  try {
    for (const file of readdirSync(join2(skillDir, "references")).filter((f) => f.endsWith(".md")).sort()) {
      references.set(file.slice(0, -3), readFileSync(join2(skillDir, "references", file), "utf8").trim());
    }
  } catch {
  }
  const topics = [...references.keys()];
  const full = [
    skill,
    ...topics.map((name) => `---

<!-- references/${name}.md (get_planning_guide topic "${name}") -->

${references.get(name)}`)
  ].join("\n\n");
  return { topics, full: () => full, topic: (name) => references.get(name) };
}
function emptyGuide(message) {
  return { topics: [], full: () => message, topic: () => void 0 };
}
function stripFrontMatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

// src/install.ts
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp as cp2, mkdir as mkdir2, readFile as readFile3, rename as rename2, rm as rm2 } from "node:fs/promises";
import { join as join4 } from "node:path";
import { randomBytes as randomBytes2 } from "node:crypto";

// src/fsutil.ts
import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile as readFile2, rename, rm, writeFile } from "node:fs/promises";
import { basename as basename2, dirname, join as join3 } from "node:path";
var SKILL_MARKER = ".tripezgo-version";
function siblingTemp(path) {
  return join3(dirname(path), `.${basename2(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
}
async function writeFileAtomic(path, data, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temp = siblingTemp(path);
  try {
    await writeFile(temp, data, mode === void 0 ? void 0 : { mode });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
async function replaceDir(src, dest, marker) {
  await mkdir(dirname(dest), { recursive: true });
  const temp = siblingTemp(dest);
  try {
    await cp(src, temp, { recursive: true });
    if (marker !== void 0) await writeFile(join3(temp, SKILL_MARKER), `${marker}
`);
    await rm(dest, { recursive: true, force: true });
    await rename(temp, dest);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}
async function readInstallConfig(path) {
  try {
    const value = JSON.parse(await readFile2(path, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const clients = value.clients;
      if (clients && typeof clients === "object" && !Array.isArray(clients)) {
        return { ...value, clients };
      }
    }
  } catch {
  }
  return { clients: {} };
}

// src/install.ts
var CLIENTS = ["claude-code", "codex", "claude-desktop"];
var INSTALL_USAGE = "Usage: npx -y github:TripEZGo/mcp install <claude-code|codex|claude-desktop>";
async function runInstall(args, deps) {
  const client = args[0];
  if (args.length !== 1 || !client || !CLIENTS.includes(client)) {
    deps.out(INSTALL_USAGE);
    return 2;
  }
  const home = join4(deps.home, ".tripezgo");
  const launcher = join4(home, "launcher.mjs");
  const tag = `v${deps.version}`;
  const summary = [];
  try {
    await mkdir2(home, { recursive: true });
    await writeFileAtomic(launcher, await readFile3(join4(deps.packageRoot, "dist", "launcher.mjs")));
    summary.push(`Launcher: ${launcher}`);
    summary.push(`Cached ${tag}: ${await seedVersion(home, tag, deps.packageRoot) ? "added" : "already there"}`);
    let skillDir;
    switch (client) {
      case "claude-code": {
        const result = await installClaudeCode(deps, launcher, summary);
        if (result !== 0) return finish(deps, client, summary, result);
        skillDir = join4(deps.home, ".claude", "skills", "tripezgo");
        break;
      }
      case "codex": {
        const path = join4(deps.env.CODEX_HOME || join4(deps.home, ".codex"), "config.toml");
        let toml = "";
        try {
          toml = await readFile3(path, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await writeFileAtomic(path, upsertCodexServer(toml, deps.nodePath, [launcher]));
        summary.push(`Codex MCP server "tripezgo": ${path}`);
        skillDir = join4(deps.home, ".agents", "skills", "tripezgo");
        break;
      }
      case "claude-desktop": {
        const result = await installClaudeDesktop(deps, launcher, summary);
        if (result !== 0) return finish(deps, client, summary, result);
        break;
      }
    }
    if (skillDir) {
      await replaceDir(join4(deps.packageRoot, "skills", "tripezgo"), skillDir, tag);
      summary.push(`Planning skill: ${skillDir}`);
    } else {
      summary.push("Planning guide: served by the MCP server itself (get_planning_guide)");
    }
    const configPath = join4(home, "config.json");
    const config = await readInstallConfig(configPath);
    config.clients[client] = { ...skillDir ? { skillDir } : {}, installedAt: (/* @__PURE__ */ new Date()).toISOString() };
    await writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}
`);
  } catch (error) {
    summary.push(`Failed: ${error.message}`);
    return finish(deps, client, summary, 1);
  }
  return finish(deps, client, summary, 0);
}
var CLIENT_NAMES = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "claude-desktop": "Claude Desktop"
};
function finish(deps, client, summary, code) {
  deps.out(code === 0 ? `TripEZGo is installed for ${CLIENT_NAMES[client]}.` : `TripEZGo was NOT installed for ${CLIENT_NAMES[client]}.`);
  for (const line of summary) deps.out(`  ${line}`);
  if (code === 0) {
    deps.out("");
    if (client === "claude-desktop") {
      deps.out("Fully quit Claude Desktop (Quit from the menu, not just closing the window) and open it again.");
    } else {
      deps.out(`Start a new ${CLIENT_NAMES[client]} session to pick it up.`);
    }
    deps.out(
      'To connect: on the iPhone open TripEZGo \u203A Settings \u203A \u7528\u96FB\u8166 AI \u7DE8\u8F2F ("Connect computer AI") and paste the sentence it shows (\u9023\u63A5 TripEZGo\uFF1A\u2026\uFF0C\u91D1\u9470 \u2026) into the conversation.'
    );
    deps.out("Updates install themselves each time the AI app starts the server. Re-running this command is harmless.");
  }
  return code;
}
async function seedVersion(home, tag, packageRoot) {
  const versions = join4(home, "versions");
  const target = join4(versions, tag);
  if (existsSync(join4(target, "dist", "cli.js"))) return false;
  await mkdir2(versions, { recursive: true });
  const temp = join4(home, "tmp", `seed-${process.pid}-${randomBytes2(4).toString("hex")}`);
  try {
    await mkdir2(temp, { recursive: true });
    for (const entry of ["dist", "skills", "snapshot", "package.json"]) {
      const from = join4(packageRoot, entry);
      if (existsSync(from)) await cp2(from, join4(temp, entry), { recursive: true });
    }
    await rm2(target, { recursive: true, force: true });
    await rename2(temp, target);
  } finally {
    await rm2(temp, { recursive: true, force: true });
  }
  return true;
}
async function installClaudeCode(deps, launcher, summary) {
  const claude = (...args) => deps.run("claude", args);
  const version2 = await claude("--version");
  if (version2.notFound) {
    summary.push("The `claude` command isn't on PATH. Install Claude Code first (https://claude.com/claude-code), then run this again.");
    return 1;
  }
  const plugins = parseJsonArray((await claude("plugin", "list", "--json")).stdout);
  for (const plugin of plugins) {
    if (plugin.id !== "tripezgo@tripezgo") continue;
    const scope = typeof plugin.scope === "string" ? plugin.scope : "user";
    const result = await claude("plugin", "uninstall", "tripezgo@tripezgo", "-s", scope);
    summary.push(
      result.code === 0 ? `Removed the old tripezgo plugin (${scope} scope)` : `Couldn't remove the old tripezgo plugin (${scope} scope): ${(result.stderr || result.stdout).trim()}`
    );
  }
  const marketplaces = parseJsonArray((await claude("plugin", "marketplace", "list", "--json")).stdout);
  if (marketplaces.some((m) => m.name === "tripezgo")) {
    const result = await claude("plugin", "marketplace", "remove", "tripezgo");
    summary.push(
      result.code === 0 ? "Removed the old tripezgo marketplace" : `Couldn't remove the old tripezgo marketplace: ${(result.stderr || result.stdout).trim()}`
    );
  }
  await claude("mcp", "remove", "-s", "user", "tripezgo");
  const add = await claude("mcp", "add", "-s", "user", "tripezgo", "--", deps.nodePath, launcher);
  if (add.code !== 0) {
    summary.push(`claude mcp add failed: ${(add.stderr || add.stdout).trim() || `exit ${add.code}`}`);
    return 1;
  }
  summary.push(`Claude Code MCP server "tripezgo" (user scope): ${deps.nodePath} ${launcher}`);
  summary.push(
    "If you once added tripezgo inside a project with the old `claude mcp add --transport http` command, run `claude mcp remove tripezgo -s local` in that project so it doesn't hide this one."
  );
  return 0;
}
async function installClaudeDesktop(deps, launcher, summary) {
  const path = claudeDesktopConfigPath(deps);
  if (!path) {
    summary.push("Can't find Claude Desktop's settings folder (%APPDATA% is not set).");
    return 1;
  }
  let config = {};
  let text;
  try {
    text = await readFile3(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (text !== void 0 && text.trim() !== "") {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      config = parsed;
    } catch {
      summary.push(`${path} isn't valid JSON, so it was left alone. Fix or remove it, then run this again.`);
      return 1;
    }
  }
  const servers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ? config.mcpServers : {};
  servers.tripezgo = { command: deps.nodePath, args: [launcher] };
  config.mcpServers = servers;
  await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}
`);
  summary.push(`Claude Desktop MCP server "tripezgo": ${path}`);
  return 0;
}
function claudeDesktopConfigPath(deps) {
  const file = "claude_desktop_config.json";
  if (deps.platform === "darwin") return join4(deps.home, "Library", "Application Support", "Claude", file);
  if (deps.platform === "win32") return deps.env.APPDATA ? join4(deps.env.APPDATA, "Claude", file) : void 0;
  return join4(deps.env.XDG_CONFIG_HOME || join4(deps.home, ".config"), "Claude", file);
}
function upsertCodexServer(toml, command, args) {
  const kept = [];
  let table = "";
  let skippingTable = false;
  let openValue = 0;
  for (const line of toml.split(/\r?\n/)) {
    if (openValue > 0) {
      openValue += bracketBalance(line);
      continue;
    }
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      table = normalizeTomlKey(header[1]);
      skippingTable = isTripezgoKey(table);
    } else if (!skippingTable) {
      const assignment = /^\s*((?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=(.*)$/.exec(line);
      if (assignment) {
        const key = normalizeTomlKey(assignment[1]);
        if (isTripezgoKey(table ? `${table}.${key}` : key)) {
          openValue = Math.max(0, bracketBalance(assignment[2]));
          continue;
        }
      }
    }
    if (!skippingTable) kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  const entry = [
    "[mcp_servers.tripezgo]",
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    // A start may download an update before the bridge answers.
    "startup_timeout_sec = 30"
  ];
  return [...kept, ...kept.length > 0 ? [""] : [], ...entry, ""].join("\n");
}
function normalizeTomlKey(key) {
  return key.split(".").map((part) => part.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")).join(".");
}
function isTripezgoKey(key) {
  return key === "mcp_servers.tripezgo" || key.startsWith("mcp_servers.tripezgo.");
}
function bracketBalance(text) {
  const bare = text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "").replace(/#.*$/, "");
  return (bare.match(/[{[]/g)?.length ?? 0) - (bare.match(/[}\]]/g)?.length ?? 0);
}
function tomlString(value) {
  return JSON.stringify(value);
}
function parseJsonArray(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v) => !!v && typeof v === "object") : [];
  } catch {
    return [];
  }
}
var STABLE_NODE_PATHS = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
function stableNodePath(execPath, candidates = STABLE_NODE_PATHS) {
  let actual;
  try {
    actual = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const candidate of candidates) {
    try {
      if (realpathSync(candidate) === actual) return candidate;
    } catch {
    }
  }
  return execPath;
}
function runCommand(command, args) {
  const windows = process.platform === "win32";
  return new Promise((resolve3) => {
    const child = windows ? spawn(command, args.map((arg) => `"${arg}"`), { stdio: ["ignore", "pipe", "pipe"], shell: true }) : spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk.toString());
    child.stderr.on("data", (chunk) => stderr += chunk.toString());
    child.on(
      "error",
      (error) => resolve3({ code: -1, stdout, stderr: error.message, notFound: error.code === "ENOENT" })
    );
    child.on(
      "close",
      (code) => resolve3({ code: code ?? -1, stdout, stderr, notFound: windows && (code === 9009 || /is not recognized/.test(stderr)) })
    );
  });
}

// src/package.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2, join as join5, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
function packageRootOf(moduleUrl) {
  return resolve2(dirname2(fileURLToPath(moduleUrl)), "..");
}
function packageVersion(root2) {
  try {
    const pkg = JSON.parse(readFileSync2(join5(root2, "package.json"), "utf8"));
    return isObject(pkg) && typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
var SNAPSHOT_PATH = join5("snapshot", "app-tools.json");
var SKILL_PATH = join5("skills", "tripezgo");
function loadAppToolSnapshot(root2, log2) {
  try {
    const value = JSON.parse(readFileSync2(join5(root2, SNAPSHOT_PATH), "utf8"));
    if (isObject(value) && Array.isArray(value.tools)) {
      return value.tools.filter((tool) => isObject(tool) && typeof tool.name === "string" && isObject(tool.inputSchema));
    }
    log2?.(`${SNAPSHOT_PATH} has no tools array; listing only the local tools`);
  } catch (error) {
    log2?.(`can't read ${SNAPSHOT_PATH} (${error.message}); listing only the local tools`);
  }
  return [];
}

// src/session.ts
var CONNECT_TOOL_NAME = "connect";
var GUIDE_TOOL_NAME = "get_planning_guide";
var SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
var CONNECT_SENTENCE_TEMPLATES = [
  "\u9023\u63A5 TripEZGo\uFF1A%1\uFF0C\u91D1\u9470 %2",
  "\u8FDE\u63A5 TripEZGo\uFF1A%1\uFF0C\u5BC6\u94A5 %2",
  "Connect to TripEZGo: %1, key %2",
  "TripEZGo \u306B\u63A5\u7D9A\uFF1A%1\u3001\u30AD\u30FC %2",
  "TripEZGo \uC5F0\uACB0: %1, \uD0A4 %2"
];
var SENTENCE_EXAMPLES = CONNECT_SENTENCE_TEMPLATES.map(
  (template) => `"${template.replace("%1", "192.168.1.23:8765").replace("%2", "abc123")}"`
).join(" / ");
var INSTRUCTIONS = `TripEZGo is a travel-planning iPhone app. These tools reach the app on the user's iPhone over the local Wi-Fi, after you connect to it. When the user pastes a connect sentence \u2014 in any of the app's languages: ${SENTENCE_EXAMPLES} \u2014 call \`connect\` right away with that address (IP:PORT) and key. When you are not connected yet and need the app: ${CONNECT_HOWTO} The connection lasts while that page stays open on the phone; if a tool later says the connection ended, ask for the sentence again. Before planning a trip or changing one, call \`get_planning_guide\` and follow it.`;
var SessionBridge = class {
  constructor(options) {
    this.options = options;
  }
  connection;
  clientInfo;
  clientProtocolVersion;
  nextConnectId = 1;
  async handle(line) {
    const raw = line.trim();
    if (raw === "") return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [errorLine(null, ErrorCode.ParseError, "Parse error: stdin line is not JSON")];
    }
    if (!isObject(parsed)) return [errorLine(null, ErrorCode.InvalidRequest, "Send one JSON-RPC object per line.")];
    if (typeof parsed.method !== "string" || !hasId(parsed)) return [];
    const id = parsed.id;
    const params = isObject(parsed.params) ? parsed.params : {};
    switch (parsed.method) {
      case "initialize":
        return [resultLine(id, this.initialize(params))];
      case "ping":
        return [resultLine(id, {})];
      case "tools/list":
        return [resultLine(id, { tools: this.tools() })];
      case "tools/call":
        return this.callTool(id, params, raw);
      default:
        return [errorLine(id, ErrorCode.MethodNotFound, `Method not found: ${parsed.method}`)];
    }
  }
  initialize(params) {
    if (isObject(params.clientInfo)) this.clientInfo = params.clientInfo;
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : void 0;
    const version2 = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
    this.clientProtocolVersion = version2;
    return {
      protocolVersion: version2,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "TripEZGo", version: this.options.version },
      instructions: INSTRUCTIONS
    };
  }
  tools() {
    const local = /* @__PURE__ */ new Set([CONNECT_TOOL_NAME, GUIDE_TOOL_NAME, LOCAL_TOOL_NAME]);
    return [
      connectTool(),
      guideTool(this.options.guide),
      ...this.options.appTools.filter((tool) => !local.has(tool.name)),
      localTool(this.connection?.uploadLimitBytes ?? DEFAULT_UPLOAD_LIMIT_BYTES)
    ];
  }
  async callTool(id, params, raw) {
    const name = params.name;
    if (typeof name !== "string" || name === "") return [errorLine(id, ErrorCode.InvalidParams, "tools/call needs a tool name.")];
    const args = isObject(params.arguments) ? params.arguments : {};
    if (name === CONNECT_TOOL_NAME) return [resultLine(id, await this.connect(args))];
    if (name === GUIDE_TOOL_NAME) return [resultLine(id, this.planningGuide(args))];
    const connection = this.connection;
    if (!connection) return [resultLine(id, toolFailure(notConnectedMessage(name)))];
    if (name === LOCAL_TOOL_NAME) {
      const result = await addAttachmentFromPath(args, {
        baseUrl: connection.baseUrl,
        token: connection.token,
        fetch: this.options.fetch,
        timeoutMs: this.options.uploadTimeoutMs,
        maxBytes: connection.uploadLimitBytes,
        unauthorizedMessage: connectionLostMessage(401),
        wording: "sentence",
        onUnauthorized: () => this.drop(connection)
      });
      return [resultLine(id, result)];
    }
    return this.forwardCall(id, name, raw, connection);
  }
  planningGuide(args) {
    const { guide } = this.options;
    if (args.topic === void 0 || args.topic === null || args.topic === "") return toolText(guide.full());
    const text = typeof args.topic === "string" ? guide.topic(args.topic) : void 0;
    if (text === void 0) return toolFailure(`No guide topic "${String(args.topic)}". Topics: ${guide.topics.join(", ")}.`);
    return toolText(text);
  }
  // MARK: connect
  async connect(args) {
    const address = typeof args.address === "string" ? args.address.trim() : "";
    const token = typeof args.token === "string" ? args.token.trim() : "";
    if (!address || !token) {
      return toolFailure(`connect needs both the address and the key from the connect sentence. ${CONNECT_HOWTO}`);
    }
    let baseUrl;
    try {
      assertPrivateAddress(address, { allowLoopback: this.options.allowLoopback });
      baseUrl = normalizeBaseUrl(address);
    } catch (error) {
      if (error instanceof ConfigError) return toolFailure(`${error.message}. The address looks like 192.168.1.23:8765.`);
      throw error;
    }
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: `tripezgo-connect-${this.nextConnectId++}`,
      method: "initialize",
      params: {
        protocolVersion: this.clientProtocolVersion ?? SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: {},
        // The app's activity log names the client from this, so pass on the real one ("claude-code", …).
        clientInfo: this.clientInfo ?? { name: "TripEZGo bridge", version: this.options.version }
      }
    });
    let response;
    try {
      response = await this.post(baseUrl, token, body, {});
    } catch (error) {
      return toolFailure(unreachableMessage(baseUrl, error, "sentence"));
    }
    const text = await response.text();
    if (response.status === 401) return toolFailure(connectUnauthorizedMessage());
    if (!response.ok) return toolFailure(`The TripEZGo app answered HTTP ${response.status}: ${text.trim() || "no body"}`);
    let result;
    let appError;
    for (const bodyText of rpcBodies(text, response.headers.get("content-type") ?? "")) {
      try {
        const message = JSON.parse(bodyText);
        if (isObject(message) && isObject(message.result)) result = message.result;
        else if (isObject(message) && isObject(message.error)) appError = String(message.error.message);
      } catch {
      }
    }
    if (!result) return toolFailure(`The TripEZGo app didn't accept the connection: ${appError ?? (text.trim() || "no initialize result")}`);
    const serverInfo = isObject(result.serverInfo) ? result.serverInfo : {};
    const connection = {
      baseUrl,
      token,
      sessionId: response.headers.get("mcp-session-id") ?? void 0,
      protocolVersion: typeof result.protocolVersion === "string" ? result.protocolVersion : void 0,
      uploadLimitBytes: uploadLimitFrom(result) ?? DEFAULT_UPLOAD_LIMIT_BYTES,
      appVersion: typeof serverInfo.version === "string" ? serverInfo.version : void 0
    };
    try {
      const ack = await this.post(baseUrl, token, '{"jsonrpc":"2.0","method":"notifications/initialized"}', sessionHeaders(connection));
      if (!ack.ok) this.options.log?.(`TripEZGo app answered HTTP ${ack.status} to notifications/initialized`);
      await ack.text();
    } catch (error) {
      this.options.log?.(`notifications/initialized: ${error.message}`);
    }
    this.connection = connection;
    this.options.log?.(`connected to ${baseUrl} (TripEZGo ${connection.appVersion ?? "?"})`);
    const instructions = typeof result.instructions === "string" ? result.instructions.trim() : "";
    return toolText(
      `Connected to the TripEZGo app${connection.appVersion ? ` ${connection.appVersion}` : ""} at ${baseUrl}. It stays connected while the Connect computer AI page is open on the iPhone.` + (instructions ? `

The app's instructions:

${instructions}` : "")
    );
  }
  // MARK: forwarding
  async forwardCall(id, name, raw, connection) {
    let response;
    try {
      response = await this.post(connection.baseUrl, connection.token, raw, sessionHeaders(connection));
    } catch (error) {
      return [resultLine(id, toolFailure(unreachableMessage(connection.baseUrl, error, "sentence")))];
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) connection.sessionId = sessionId;
    const text = await response.text();
    const bodies = rpcBodies(text, response.headers.get("content-type") ?? "");
    if (response.status === 401 || response.status === 404) {
      this.drop(connection);
      return [resultLine(id, toolFailure(connectionLostMessage(response.status)))];
    }
    if (!response.ok && !bodies.some(isRpcMessage)) {
      return [resultLine(id, toolFailure(`The TripEZGo app answered HTTP ${response.status}: ${appErrorText(text)}`))];
    }
    return bodies.map((body) => this.passBack(body, name, connection));
  }
  passBack(body, name, connection) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return body.replace(/\r?\n/g, " ");
    }
    if (isObject(parsed) && isObject(parsed.error) && parsed.error.code === ErrorCode.InvalidParams && typeof parsed.error.message === "string" && parsed.error.message.startsWith("Unknown tool:")) {
      return resultLine(parsed.id, toolFailure(unsupportedToolMessage(name, connection.appVersion)));
    }
    return /[\r\n]/.test(body) ? JSON.stringify(parsed) : body.trim();
  }
  drop(connection) {
    if (this.connection === connection) this.connection = void 0;
  }
  post(baseUrl, token, body, extra) {
    return (this.options.fetch ?? phoneFetch)(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        ...extra
      },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 6e4)
    });
  }
};
function sessionHeaders(connection) {
  const headers = {};
  if (connection.sessionId) headers["Mcp-Session-Id"] = connection.sessionId;
  if (connection.protocolVersion) headers["MCP-Protocol-Version"] = connection.protocolVersion;
  return headers;
}
function isRpcMessage(body) {
  try {
    const value = JSON.parse(body);
    return isObject(value) && value.jsonrpc === "2.0";
  } catch {
    return false;
  }
}
function appErrorText(text) {
  try {
    const value = JSON.parse(text);
    if (isObject(value) && typeof value.error === "string") return value.error;
  } catch {
  }
  return text.trim() || "no body";
}
function connectTool() {
  return {
    name: CONNECT_TOOL_NAME,
    title: "Connect to the TripEZGo app",
    description: `Connect to the TripEZGo app on the user's iPhone. Call this when the user pastes the connect sentence from the app's Connect computer AI page, in any of the app's languages: ${SENTENCE_EXAMPLES}. address is the IP:PORT part, token is the key. Calling it again replaces the previous connection. Every other TripEZGo tool needs a connection first.`,
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "The address from the sentence, e.g. 192.168.1.23:8765 (http://\u2026 and \u2026/mcp work too)." },
        token: { type: "string", description: "The key from the sentence (\u91D1\u9470 / \u5BC6\u94A5 / key / \u30AD\u30FC / \uD0A4)." }
      },
      required: ["address", "token"]
    }
  };
}
function guideTool(guide) {
  return {
    name: GUIDE_TOOL_NAME,
    title: "TripEZGo planning guide",
    description: "How to plan a trip and how to work in TripEZGo: the steps, sources and rules to follow. Call it before planning a trip or changing one. No connection needed. Without topic it returns the whole guide; with topic, one section of it.",
    inputSchema: {
      type: "object",
      properties: {
        // An empty enum would admit no value at all; with no topics, leave the choice open.
        topic: {
          type: "string",
          ...guide.topics.length > 0 ? { enum: [...guide.topics] } : {},
          description: "One section of the guide. Omit for the whole guide."
        }
      }
    }
  };
}

// src/stdio.ts
import { createInterface } from "node:readline";
async function runStdio(input, output, bridge) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let chain = Promise.resolve();
  for await (const line of lines) {
    chain = chain.then(async () => {
      const replies = await bridge.handle(line);
      for (const reply of replies) output.write(`${reply}
`);
    });
  }
  await chain;
}

// src/cli.ts
var argv = process.argv.slice(2);
var root = packageRootOf(import.meta.url);
var version = packageVersion(root);
var log = (message) => process.stderr.write(`tripezgo-mcp: ${message}
`);
if (argv[0] === "install") {
  const code = await runInstall(argv.slice(1), {
    home: homedir2(),
    platform: process.platform,
    env: process.env,
    nodePath: stableNodePath(process.execPath),
    packageRoot: root,
    version,
    run: runCommand,
    out: (line) => process.stdout.write(`${line}
`)
  });
  process.exit(code);
}
if (argv.includes("--help") || argv.includes("-h")) {
  process.stderr.write(`${USAGE}
`);
  process.exit(0);
}
try {
  const config = parseConfig(argv, process.env, log);
  if (config) {
    log(`bridging stdio to ${config.baseUrl}/mcp`);
    await runStdio(process.stdin, process.stdout, new Bridge({ ...config, log }));
  } else {
    log(`${version} started; waiting for the AI to connect`);
    const bridge = new SessionBridge({
      appTools: loadAppToolSnapshot(root, log),
      guide: loadGuide(join6(root, SKILL_PATH)),
      version,
      log
    });
    await runStdio(process.stdin, process.stdout, bridge);
  }
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`tripezgo-mcp: ${error.message}

${USAGE}
`);
    process.exit(2);
  }
  throw error;
}
