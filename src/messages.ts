import { TlsHandshakeError } from "./phoneTransport.js";

/** Human-readable messages shared by the bridge and the upload tool. */

export type Wording = "command" | "sentence";

/**
 * `wording` is what the user copies from the iPhone: the 0.1 command (older app builds, `--url/--token`) or the
 * connect sentence.
 */
export function unreachableMessage(baseUrl: string, cause: unknown, wording: Wording = "command"): string {
  if (cause instanceof TlsHandshakeError) return tlsHandshakeMessage(baseUrl, cause, wording);
  const detail = cause instanceof Error ? describeCause(cause) : String(cause);
  return (
    `Can't reach the TripEZGo app at ${baseUrl} (${detail}). ` +
    `On the iPhone, keep the "Connect computer AI" page (連接電腦 AI) open with TripEZGo in the foreground, ` +
    `and make sure the phone and this computer are on the same Wi-Fi.` +
    (wording === "sentence"
      ? " If that page now shows a different address or a new connect sentence (the Wi-Fi changed, or the page " +
        "was reopened), ask the user to copy the latest connect sentence from the iPhone and paste it again, " +
        "then call `connect` with it."
      : "")
  );
}

/** The app answered the TCP connection but not the TLS handshake. There is no plaintext fallback. */
export function tlsHandshakeMessage(baseUrl: string, cause: Error, wording: Wording = "command"): string {
  return (
    `Couldn't set up the encrypted connection to the TripEZGo app at ${baseUrl} (${describeCause(cause)}). ` +
    "Either TripEZGo on the iPhone is too old for this bridge (the bridge only talks TLS with a key-derived " +
    "secret, never plain HTTP), or the key is wrong. Ask the user to update TripEZGo from the App Store, reopen the " +
    '"Connect computer AI" page (連接電腦 AI), and ' +
    (wording === "sentence" ? "paste the fresh connect sentence it shows, then call `connect` again." : "copy the new command.")
  );
}

export function unauthorizedMessage(): string {
  return (
    "The TripEZGo app rejected the token (HTTP 401). The token only works while the " +
    '"Connect computer AI" page that made it stays open; if you closed it, open the page again and ' +
    "copy the new command."
  );
}

export function apiLevelMismatchMessage(appMessage: string | undefined): string {
  return (
    "The TripEZGo app and this bridge (github:TripEZGo/mcp) speak different versions of the upload API" +
    (appMessage ? ` — the app says: ${appMessage}` : "") +
    ". Update TripEZGo from the App Store, and restart the AI app so the bridge updates itself " +
    "(an install from before 0.2.0: run `npx -y github:TripEZGo/mcp install <claude-code|codex|claude-desktop>`), then try again."
  );
}

/** Where the connect sentence comes from, and what it looks like. Said the same way everywhere. */
export const CONNECT_HOWTO =
  'Ask the user to open TripEZGo on their iPhone, go to the "Connect computer AI" page (連接電腦 AI — ' +
  "Settings › 用電腦 AI 編輯, or New trip › 用電腦 AI 建立旅程), keep it open, and paste the connect sentence it " +
  "shows; it looks like 「連接 TripEZGo：192.168.1.23:8765，金鑰 abc123」. Then call `connect` with the address " +
  "and the key from that sentence.";

export function notConnectedMessage(tool: string): string {
  return `Not connected to the TripEZGo app yet, so ${tool} can't run. ${CONNECT_HOWTO} After that, call ${tool} again.`;
}

export function connectUnauthorizedMessage(): string {
  return (
    'The TripEZGo app rejected that key (HTTP 401). A key only works while the "Connect computer AI" page ' +
    "that showed it stays open; reopening the page makes a new one. Ask the user to open the page and paste " +
    "the connect sentence it shows now, then call `connect` again."
  );
}

export function connectionLostMessage(status: number): string {
  return (
    `The TripEZGo app no longer accepts this connection (HTTP ${status}): the "Connect computer AI" page was ` +
    "closed or reopened, and that ends the old key. Ask the user to open the page on the iPhone and paste " +
    "the connect sentence it shows now, then call `connect` again."
  );
}

export function unsupportedToolMessage(tool: string, appVersion: string | undefined): string {
  return (
    `The TripEZGo app on the iPhone${appVersion ? ` (version ${appVersion})` : ""} doesn't have ${tool} yet. ` +
    'Ask the user to update TripEZGo from the App Store, reopen the "Connect computer AI" page, and paste ' +
    "the new connect sentence; then call `connect` again and retry."
  );
}

export function unsupportedArgumentsMessage(
  tool: string,
  appVersion: string | undefined,
  rejected: string[],
  accepted: string[],
): string {
  const names = rejected.map((name) => `\`${name}\``).join(", ");
  return (
    `The TripEZGo app on the iPhone${appVersion ? ` (version ${appVersion})` : ""} doesn't accept ${rejected.length === 1 ? "the argument" : "the arguments"} ` +
    `${names} for ${tool}, so nothing was sent and nothing changed. This app takes only: ` +
    `${accepted.length > 0 ? accepted.map((name) => `\`${name}\``).join(", ") : "(no arguments)"}. ` +
    `Call ${tool} again using only those arguments (the older format). ` +
    "If the user needs the newer format, they can update TripEZGo from the App Store, reopen the " +
    '"Connect computer AI" page, and paste the new connect sentence.'
  );
}

function describeCause(error: Error): string {
  if (error instanceof TlsHandshakeError) return (error.cause as Error | undefined)?.message ?? error.message;
  if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const { code, message } = cause as { code?: unknown; message?: unknown };
    if (code) return String(code);
    if (message) return String(message);
  }
  return error.message;
}
