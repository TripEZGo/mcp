/** JSON-RPC 2.0 plumbing shared by both bridges. No runtime dependency: the bundle must run from a tag tarball. */

export type Json = Record<string, unknown>;
export type Id = string | number | null;

export const ErrorCode = {
  ConnectionClosed: -32000,
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export interface TextContent {
  type: "text";
  text: string;
}

export interface CallToolResult {
  content: TextContent[];
  structuredContent?: Json;
  isError?: boolean;
  [key: string]: unknown;
}

export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Json;
  [key: string]: unknown;
}

export function errorLine(id: Id, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

export function resultLine(id: Id, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

export function toolFailure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function toolText(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function hasId(message: Json): boolean {
  return "id" in message && message.id !== undefined;
}

export function hasCursor(request: Json): boolean {
  return isObject(request.params) && request.params.cursor !== undefined;
}

export function isJsonRpc(body: string): boolean {
  try {
    const value: unknown = JSON.parse(body);
    return Array.isArray(value) || (isObject(value) && value.jsonrpc === "2.0");
  } catch {
    return false;
  }
}

/** `data:` payloads of a text/event-stream body. The app answers in JSON; this is only for robustness. */
export function sseData(text: string): string[] {
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

/** The JSON-RPC bodies of an HTTP answer, plain JSON or event stream. */
export function rpcBodies(text: string, contentType: string): string[] {
  if (contentType.includes("text/event-stream")) return sseData(text);
  return text.trim() === "" ? [] : [text];
}
