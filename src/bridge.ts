import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeConfig } from "./config.js";
import { unauthorizedMessage, unreachableMessage } from "./messages.js";
import { LOCAL_TOOL_NAME, addAttachmentFromPath, localTool } from "./upload.js";

export interface BridgeOptions extends BridgeConfig {
  fetch?: typeof fetch;
  /** Per-request timeout for `/mcp`. */
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  log?: (message: string) => void;
}

type Json = Record<string, unknown>;
type Id = string | number | null;

/**
 * Turns one stdio JSON-RPC line into the lines to write back.
 *
 * Everything is forwarded to `POST <baseUrl>/mcp` byte for byte and the app's answer is written back as
 * it came, with two exceptions: a `tools/list` result gets `add_attachment_from_path` appended, and a
 * `tools/call` of that tool is handled here instead of being forwarded.
 */
export class Bridge {
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;

  constructor(private readonly options: BridgeOptions) {}

  async handle(line: string): Promise<string[]> {
    const raw = line.trim();
    if (raw === "") return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [errorLine(null, ErrorCode.ParseError, "Parse error: stdin line is not JSON")];
    }
    const message = isObject(parsed) ? parsed : undefined;

    if (message?.method === "tools/call" && isObject(message.params) && message.params.name === LOCAL_TOOL_NAME) {
      if (!hasId(message)) return [];
      const result = await addAttachmentFromPath(message.params.arguments, {
        baseUrl: this.options.baseUrl,
        token: this.options.token,
        fetch: this.options.fetch,
        timeoutMs: this.options.uploadTimeoutMs,
      });
      return [JSON.stringify({ jsonrpc: "2.0", id: message.id, result })];
    }

    return this.forward(raw, message);
  }

  private async forward(raw: string, message: Json | undefined): Promise<string[]> {
    const isRequest = !!message && typeof message.method === "string" && hasId(message);
    const id: Id = isRequest ? (message!.id as Id) : null;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.options.token}`,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;

    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: raw,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      const text = unreachableMessage(this.options.baseUrl, error);
      if (isRequest) return [errorLine(id, ErrorCode.ConnectionClosed, text)];
      this.options.log?.(text);
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
        errorLine(id, ErrorCode.InternalError, `TripEZGo app answered HTTP ${response.status}: ${text.trim() || "no body"}`),
      ];
    }

    return bodies.map((body) => this.passBack(body, message));
  }

  /** The app's answer, unchanged unless it is the `tools/list` result or has to be squeezed onto one line. */
  private passBack(body: string, request: Json | undefined): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return body.replace(/\r?\n/g, " ");
    }

    if (isObject(parsed) && isObject(parsed.result)) {
      if (request?.method === "initialize" && typeof parsed.result.protocolVersion === "string") {
        this.protocolVersion = parsed.result.protocolVersion;
      }
      if (request?.method === "tools/list" && !hasCursor(request) && Array.isArray(parsed.result.tools)) {
        if (!parsed.result.tools.some((tool) => isObject(tool) && tool.name === LOCAL_TOOL_NAME)) {
          parsed.result.tools.push(localTool);
        }
        return JSON.stringify(parsed);
      }
    }

    return /[\r\n]/.test(body) ? JSON.stringify(parsed) : body.trim();
  }
}

function errorLine(id: Id, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasId(message: Json): boolean {
  return "id" in message && message.id !== undefined;
}

function hasCursor(request: Json): boolean {
  return isObject(request.params) && request.params.cursor !== undefined;
}

function isJsonRpc(body: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return Array.isArray(value) || (isObject(value) && value.jsonrpc === "2.0");
  } catch {
    return false;
  }
}

/** `data:` payloads of a text/event-stream body. The app answers in JSON; this is only for robustness. */
function sseData(text: string): string[] {
  const out: string[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim() !== "") out.push(data);
  }
  return out;
}
