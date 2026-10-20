import { ConfigError, assertPrivateAddress, normalizeBaseUrl } from "./config.js";
import type { PlanningGuide } from "./guide.js";
import {
  CONNECT_HOWTO,
  connectUnauthorizedMessage,
  connectionLostMessage,
  notConnectedMessage,
  unreachableMessage,
  unsupportedToolMessage,
} from "./messages.js";
import {
  type CallToolResult,
  ErrorCode,
  type Id,
  type Json,
  type Tool,
  errorLine,
  hasId,
  isObject,
  resultLine,
  rpcBodies,
  toolFailure,
  toolText,
} from "./protocol.js";
import { DEFAULT_UPLOAD_LIMIT_BYTES, LOCAL_TOOL_NAME, addAttachmentFromPath, localTool, uploadLimitFrom } from "./upload.js";

export const CONNECT_TOOL_NAME = "connect";
export const GUIDE_TOOL_NAME = "get_planning_guide";

/** Protocol versions this bridge answers to its client, newest first. The app negotiates its own. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * The connect sentence the app's page shows, in each of the app's languages (`%1` = IP:PORT, `%2` = key);
 * zh-Hant-TW and zh-Hant-HK share the first. Must match the app's Localizable strings.
 */
export const CONNECT_SENTENCE_TEMPLATES = [
  "連接 TripEZGo：%1，金鑰 %2",
  "连接 TripEZGo：%1，密钥 %2",
  "Connect to TripEZGo: %1, key %2",
  "TripEZGo に接続：%1、キー %2",
  "TripEZGo 연결: %1, 키 %2",
];

const SENTENCE_EXAMPLES = CONNECT_SENTENCE_TEMPLATES.map(
  (template) => `"${template.replace("%1", "192.168.1.23:8765").replace("%2", "abc123")}"`,
).join(" / ");

export const INSTRUCTIONS =
  "TripEZGo is a travel-planning iPhone app. These tools reach the app on the user's iPhone over the local " +
  "Wi-Fi, after you connect to it. When the user pastes a connect sentence — in any of the app's languages: " +
  `${SENTENCE_EXAMPLES} — call \`connect\` right away with that address (IP:PORT) and key. When ` +
  `you are not connected yet and need the app: ${CONNECT_HOWTO} ` +
  "The connection lasts while that page stays open on the phone; if a tool later says the connection ended, " +
  "ask for the sentence again. Before planning a trip or changing one, call `get_planning_guide` and follow it.";

export interface SessionBridgeOptions {
  /** The app's tools as of this release, listed before (and after) connecting. */
  appTools: Tool[];
  guide: PlanningGuide;
  /** This bridge's version, reported as serverInfo.version until the app is connected. */
  version: string;
  fetch?: typeof fetch;
  /** Per-request timeout for `/mcp`, `connect` included. */
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  log?: (message: string) => void;
  /** Lets `connect` reach 127.0.0.0/8. Only tests that run a fake app on this machine set it; the CLI never does. */
  allowLoopback?: boolean;
}

interface Connection {
  baseUrl: string;
  token: string;
  sessionId?: string;
  protocolVersion?: string;
  uploadLimitBytes: number;
  appVersion?: string;
}

/**
 * The bridge as installed once, with no address in its configuration: it answers the client itself, lists a
 * built-in snapshot of the app's tools, and reaches the app only after the AI calls `connect` with the
 * sentence the user pasted from the iPhone. App tool calls are then forwarded byte for byte.
 */
export class SessionBridge {
  private connection: Connection | undefined;
  private clientInfo: Json | undefined;
  private clientProtocolVersion: string | undefined;
  private nextConnectId = 1;

  constructor(private readonly options: SessionBridgeOptions) {}

  async handle(line: string): Promise<string[]> {
    const raw = line.trim();
    if (raw === "") return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [errorLine(null, ErrorCode.ParseError, "Parse error: stdin line is not JSON")];
    }
    if (!isObject(parsed)) return [errorLine(null, ErrorCode.InvalidRequest, "Send one JSON-RPC object per line.")];
    // A response from the client, or a notification: nothing to answer. The app gets its own
    // `notifications/initialized` from `connect`.
    if (typeof parsed.method !== "string" || !hasId(parsed)) return [];

    const id = parsed.id as Id;
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

  private initialize(params: Json): Json {
    if (isObject(params.clientInfo)) this.clientInfo = params.clientInfo;
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
    const version = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
    this.clientProtocolVersion = version;
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "TripEZGo", version: this.options.version },
      instructions: INSTRUCTIONS,
    };
  }

  private tools(): Tool[] {
    const local = new Set([CONNECT_TOOL_NAME, GUIDE_TOOL_NAME, LOCAL_TOOL_NAME]);
    return [
      connectTool(),
      guideTool(this.options.guide),
      ...this.options.appTools.filter((tool) => !local.has(tool.name)),
      localTool(this.connection?.uploadLimitBytes ?? DEFAULT_UPLOAD_LIMIT_BYTES),
    ];
  }

  private async callTool(id: Id, params: Json, raw: string): Promise<string[]> {
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
        onUnauthorized: () => this.drop(connection),
      });
      return [resultLine(id, result)];
    }

    return this.forwardCall(id, name, raw, connection);
  }

  private planningGuide(args: Json): CallToolResult {
    const { guide } = this.options;
    if (args.topic === undefined || args.topic === null || args.topic === "") return toolText(guide.full());
    const text = typeof args.topic === "string" ? guide.topic(args.topic) : undefined;
    if (text === undefined) return toolFailure(`No guide topic "${String(args.topic)}". Topics: ${guide.topics.join(", ")}.`);
    return toolText(text);
  }

  // MARK: connect

  private async connect(args: Json): Promise<CallToolResult> {
    const address = typeof args.address === "string" ? args.address.trim() : "";
    const token = typeof args.token === "string" ? args.token.trim() : "";
    if (!address || !token) {
      return toolFailure(`connect needs both the address and the key from the connect sentence. ${CONNECT_HOWTO}`);
    }
    let baseUrl: string;
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
        clientInfo: this.clientInfo ?? { name: "TripEZGo bridge", version: this.options.version },
      },
    });

    let response: Response;
    try {
      response = await this.post(baseUrl, token, body, {});
    } catch (error) {
      return toolFailure(unreachableMessage(baseUrl, error, "sentence"));
    }
    const text = await response.text();
    if (response.status === 401) return toolFailure(connectUnauthorizedMessage());
    if (!response.ok) return toolFailure(`The TripEZGo app answered HTTP ${response.status}: ${text.trim() || "no body"}`);

    let result: Json | undefined;
    let appError: string | undefined;
    for (const bodyText of rpcBodies(text, response.headers.get("content-type") ?? "")) {
      try {
        const message: unknown = JSON.parse(bodyText);
        if (isObject(message) && isObject(message.result)) result = message.result;
        else if (isObject(message) && isObject(message.error)) appError = String(message.error.message);
      } catch {
        // Not JSON: reported below as "no initialize result".
      }
    }
    if (!result) return toolFailure(`The TripEZGo app didn't accept the connection: ${appError ?? (text.trim() || "no initialize result")}`);

    const serverInfo = isObject(result.serverInfo) ? result.serverInfo : {};
    const connection: Connection = {
      baseUrl,
      token,
      sessionId: response.headers.get("mcp-session-id") ?? undefined,
      protocolVersion: typeof result.protocolVersion === "string" ? result.protocolVersion : undefined,
      uploadLimitBytes: uploadLimitFrom(result) ?? DEFAULT_UPLOAD_LIMIT_BYTES,
      appVersion: typeof serverInfo.version === "string" ? serverInfo.version : undefined,
    };

    try {
      const ack = await this.post(baseUrl, token, '{"jsonrpc":"2.0","method":"notifications/initialized"}', sessionHeaders(connection));
      if (!ack.ok) this.options.log?.(`TripEZGo app answered HTTP ${ack.status} to notifications/initialized`);
      await ack.text();
    } catch (error) {
      this.options.log?.(`notifications/initialized: ${(error as Error).message}`);
    }

    this.connection = connection;
    this.options.log?.(`connected to ${baseUrl} (TripEZGo ${connection.appVersion ?? "?"})`);
    const instructions = typeof result.instructions === "string" ? result.instructions.trim() : "";
    return toolText(
      `Connected to the TripEZGo app${connection.appVersion ? ` ${connection.appVersion}` : ""} at ${baseUrl}. ` +
        "It stays connected while the Connect computer AI page is open on the iPhone." +
        (instructions ? `\n\nThe app's instructions:\n\n${instructions}` : ""),
    );
  }

  // MARK: forwarding

  private async forwardCall(id: Id, name: string, raw: string, connection: Connection): Promise<string[]> {
    let response: Response;
    try {
      response = await this.post(connection.baseUrl, connection.token, raw, sessionHeaders(connection));
    } catch (error) {
      // The phone locked or left the page for a moment; the same key works again when it comes back.
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

  private passBack(body: string, name: string, connection: Connection): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return body.replace(/\r?\n/g, " ");
    }
    if (
      isObject(parsed) &&
      isObject(parsed.error) &&
      parsed.error.code === ErrorCode.InvalidParams &&
      typeof parsed.error.message === "string" &&
      parsed.error.message.startsWith("Unknown tool:")
    ) {
      return resultLine(parsed.id as Id, toolFailure(unsupportedToolMessage(name, connection.appVersion)));
    }
    return /[\r\n]/.test(body) ? JSON.stringify(parsed) : body.trim();
  }

  private drop(connection: Connection): void {
    if (this.connection === connection) this.connection = undefined;
  }

  private post(baseUrl: string, token: string, body: string, extra: Record<string, string>): Promise<Response> {
    return (this.options.fetch ?? fetch)(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        ...extra,
      },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    });
  }
}

function sessionHeaders(connection: Connection): Record<string, string> {
  const headers: Record<string, string> = {};
  if (connection.sessionId) headers["Mcp-Session-Id"] = connection.sessionId;
  if (connection.protocolVersion) headers["MCP-Protocol-Version"] = connection.protocolVersion;
  return headers;
}

function isRpcMessage(body: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return isObject(value) && value.jsonrpc === "2.0";
  } catch {
    return false;
  }
}

/** The app's error bodies are `{"error": "…"}`; fall back to the raw text. */
function appErrorText(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (isObject(value) && typeof value.error === "string") return value.error;
  } catch {
    // not JSON
  }
  return text.trim() || "no body";
}

export function connectTool(): Tool {
  return {
    name: CONNECT_TOOL_NAME,
    title: "Connect to the TripEZGo app",
    description:
      "Connect to the TripEZGo app on the user's iPhone. Call this when the user pastes the connect sentence " +
      `from the app's Connect computer AI page, in any of the app's languages: ${SENTENCE_EXAMPLES}. ` +
      "address is the IP:PORT part, token is the key. Calling it again replaces the previous connection. Every " +
      "other TripEZGo tool needs a connection first.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "The address from the sentence, e.g. 192.168.1.23:8765 (http://… and …/mcp work too)." },
        token: { type: "string", description: "The key from the sentence (金鑰 / 密钥 / key / キー / 키)." },
      },
      required: ["address", "token"],
    },
  };
}

export function guideTool(guide: PlanningGuide): Tool {
  return {
    name: GUIDE_TOOL_NAME,
    title: "TripEZGo planning guide",
    description:
      "How to plan a trip and how to work in TripEZGo: the steps, sources and rules to follow. Call it before " +
      "planning a trip or changing one. No connection needed. Without topic it returns the whole guide; " +
      "with topic, one section of it.",
    inputSchema: {
      type: "object",
      properties: {
        // An empty enum would admit no value at all; with no topics, leave the choice open.
        topic: {
          type: "string",
          ...(guide.topics.length > 0 ? { enum: [...guide.topics] } : {}),
          description: "One section of the guide. Omit for the whole guide.",
        },
      },
    },
  };
}
