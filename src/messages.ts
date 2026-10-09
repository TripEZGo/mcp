/** Human-readable messages shared by the bridge and the upload tool. */

export function unreachableMessage(baseUrl: string, cause: unknown): string {
  const detail = cause instanceof Error ? describeCause(cause) : String(cause);
  return (
    `Can't reach the TripEZGo app at ${baseUrl} (${detail}). ` +
    `On the iPhone, keep the "Connect computer AI" page (連接電腦 AI) open with TripEZGo in the foreground, ` +
    `and make sure the phone and this computer are on the same Wi-Fi.`
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
    ". Update TripEZGo from the App Store and the bridge to the latest github:TripEZGo/mcp " +
    "(restart the AI app so npx fetches it again), then try again."
  );
}

function describeCause(error: Error): string {
  if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const { code, message } = cause as { code?: unknown; message?: unknown };
    if (code) return String(code);
    if (message) return String(message);
  }
  return error.message;
}
