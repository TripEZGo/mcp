import { phoneFetch } from "./phoneTransport.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { CallToolResult, Tool } from "./protocol.js";
import { type Wording, apiLevelMismatchMessage, unauthorizedMessage, unreachableMessage } from "./messages.js";
import { mimeTypeFor } from "./mime.js";

/** The upload contract this bridge speaks. The app answers 409 when it no longer matches. */
export const API_LEVEL = 1;
/**
 * Used until the app says otherwise. The app states its own limit in the `initialize` result as
 * `_meta["tripezgo/uploadLimitBytes"]` (one attachment's limit in the app), and that is what counts.
 */
export const DEFAULT_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
export const UPLOAD_LIMIT_META_KEY = "tripezgo/uploadLimitBytes";
export const LOCAL_TOOL_NAME = "add_attachment_from_path";

/** The app's upload limit from an `initialize` result, or undefined when it does not state a usable one. */
export function uploadLimitFrom(initializeResult: unknown): number | undefined {
  if (!initializeResult || typeof initializeResult !== "object") return undefined;
  const meta = (initializeResult as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const value = (meta as Record<string, unknown>)[UPLOAD_LIMIT_META_KEY];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function localTool(maxBytes: number = DEFAULT_UPLOAD_LIMIT_BYTES): Tool {
  return {
    name: LOCAL_TOOL_NAME,
    title: "Attach a file from this computer",
    description:
      `Attach a file that is on this computer to a TripEZGo trip or event (up to ${formatMB(maxBytes)}). ` +
      "The file is read here and uploaded to the app. Without eventId the file is attached to the trip " +
      "itself; without tripId the app's default trip is used. Prefer this over add_attachment for any file on disk.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path of the file on this computer. Absolute, ~/…, or relative to the bridge's working directory.",
        },
        tripId: { type: "string", description: "Trip id from list_trips. Defaults to the app's default trip." },
        eventId: { type: "string", description: "Event id from list_events. Omit to attach to the trip." },
        name: { type: "string", description: "File name to show in the app. Defaults to the file's own name." },
      },
      required: ["path"],
    },
  };
}

export interface UploadOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The app's upload limit (from `initialize`); defaults to `DEFAULT_UPLOAD_LIMIT_BYTES`. */
  maxBytes?: number;
  /** What to say on a 401; the connect-by-sentence bridge asks for a new sentence instead of a new command. */
  unauthorizedMessage?: string;
  /** What the user copies from the phone, for the can't-reach message. */
  wording?: Wording;
  /** Called when the app refuses the token (HTTP 401): the connection is over. */
  onUnauthorized?: () => void;
}

export async function addAttachmentFromPath(args: unknown, options: UploadOptions): Promise<CallToolResult> {
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const rawPath = input.path;
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return failure("`path` is required: the path of the file on this computer.");
  }
  const requested = expandPath(rawPath.trim());

  // Judge the real location, not the name given: a symlink or `..` can't smuggle a secret past the rules.
  let filePath: string;
  try {
    filePath = await realpath(requested);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) return failure(`Can't read ${requested}: ${(error as Error).message}`);
    // Nothing there to resolve: judge the spelled path so a secret folder never reveals what it does (not) hold.
    const refusal = await sensitivePathRefusal(requested);
    return failure(refusal ?? `No file at ${requested}.`);
  }
  const refusal = await sensitivePathRefusal(filePath);
  if (refusal) return failure(refusal);

  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return failure(`${filePath} is not a file.`);
    size = info.size;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return failure(`No file at ${filePath}.`);
    return failure(`Can't read ${filePath}: ${(error as Error).message}`);
  }
  const maxBytes = options.maxBytes ?? DEFAULT_UPLOAD_LIMIT_BYTES;
  if (size > maxBytes) {
    return failure(`${filePath} is ${formatMB(size)}; TripEZGo attachments are limited to ${formatMB(maxBytes)}.`);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    return failure(`Can't read ${filePath}: ${(error as Error).message}`);
  }

  const name = typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim() : basename(filePath);
  const query = new URLSearchParams();
  if (typeof input.tripId === "string" && input.tripId !== "") query.set("tripId", input.tripId);
  if (typeof input.eventId === "string" && input.eventId !== "") query.set("eventId", input.eventId);
  query.set("name", name);

  const doFetch = options.fetch ?? phoneFetch;
  let response: Response;
  try {
    response = await doFetch(`${options.baseUrl}/upload?${query.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        "X-TripEZGo-Api-Level": String(API_LEVEL),
        "Content-Type": mimeTypeFor(filePath),
      },
      body: bytes,
      signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
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
        text: `Attached "${shownName}" (${byteCount} bytes) as attachment ${String(attachmentId)}.\n${text.trim()}`,
      },
    ],
    ...(json ? { structuredContent: json } : {}),
  };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Under the home folder, where credentials live (besides every dot folder, which is refused wholesale). */
const SENSITIVE_HOME_FOLDERS = [".ssh", ".aws", ".gnupg", ".config", join("Library", "Keychains")];

const WHY =
  "Hidden files and folders and credential stores (~/.ssh, ~/.aws, ~/.gnupg, ~/.config, ~/Library/Keychains) hold " +
  "keys, tokens and passwords, so add_attachment_from_path never reads them: an AI that was tricked by text in " +
  "a web page, file or tool result could otherwise upload them to the phone. If the user really wants this " +
  "file attached, they can copy it to an ordinary folder themselves and give that path.";

/** The reason to refuse an already resolved absolute path, or undefined when it is fine to read. */
async function sensitivePathRefusal(path: string): Promise<string | undefined> {
  const hidden = path.split(sep).find((part) => part.startsWith(".") && part !== "." && part !== "..");
  if (hidden) return `Refusing to read ${path}: "${hidden}" is a hidden (dot) file or folder. ${WHY}`;

  // The home folder may itself be reached through a symlink, so compare against both spellings.
  const homes = new Set([homedir()]);
  try {
    homes.add(await realpath(homedir()));
  } catch {
    // no home to resolve
  }
  // macOS volumes ignore case, so `~/library/keychains` is the same folder.
  const fold = (value: string) => (process.platform === "darwin" || process.platform === "win32" ? value.toLowerCase() : value);
  for (const home of homes) {
    for (const folder of SENSITIVE_HOME_FOLDERS) {
      const guarded = join(home, folder);
      if (fold(path) === fold(guarded) || fold(path).startsWith(fold(guarded) + sep)) {
        return `Refusing to read ${path}: it is inside ~/${folder.split(sep).join("/")}. ${WHY}`;
      }
    }
  }
  return undefined;
}

function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === code;
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function errorText(json: Record<string, unknown> | undefined): string | undefined {
  return typeof json?.error === "string" ? json.error : undefined;
}
