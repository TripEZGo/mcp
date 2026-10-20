export interface BridgeConfig {
  /** The app's base URL, e.g. `http://192.168.1.5:8765` — no trailing slash, no `/mcp`. */
  baseUrl: string;
  token: string;
}

export const USAGE = `Usage:
  npx -y github:TripEZGo/mcp install <claude-code|codex|claude-desktop>
      Install the TripEZGo MCP server and planning skill once; it updates itself.
  tripezgo-mcp
      Run the bridge on stdio. The AI connects with the sentence the iPhone shows
      (連接 TripEZGo：IP:PORT，金鑰 TOKEN) through the connect tool.
  TRIPEZGO_URL=http://IP:PORT TRIPEZGO_TOKEN=TOKEN npx -y github:TripEZGo/mcp
      Older app versions: bridge to one address and token, shown on the TripEZGo
      "Connect computer AI" page.
  npx -y github:TripEZGo/mcp --url http://IP:PORT --token=TOKEN
      Deprecated: --token puts the key in the process list for every user of this
      computer to read. Use TRIPEZGO_TOKEN instead.`;

export class ConfigError extends Error {}

const KNOWN_FLAGS = ["url", "token"];

/** `--url` / `--token`, alone or as `--url=…` / `--token=…`. */
function isKnownFlag(arg: string): boolean {
  return KNOWN_FLAGS.some((name) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

/**
 * Reads `--url` / `--token` (flags win) or `TRIPEZGO_URL` / `TRIPEZGO_TOKEN`. Neither anywhere → `undefined`:
 * the bridge starts unconnected and the AI connects with the `connect` tool. `--token` still works but is
 * deprecated (a command-line argument shows in the process list): `warn` is told once.
 */
export function parseConfig(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  warn?: (message: string) => void,
): BridgeConfig | undefined {
  const flags = new Map<string, string>();
  const set = (name: string, value: string) => {
    // A second value would silently win over the first; say so instead.
    if (flags.has(name)) throw new ConfigError(`--${name} given more than once`);
    flags.set(name, value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new ConfigError(`Unexpected argument: ${arg}`);
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    // The next argument is the value, whatever it looks like: the token is base64url and can start with "-"
    // (even "--"). Only the other known flag is not a value — that is a value left out.
    const value = argv[i + 1];
    if (value === undefined || isKnownFlag(value)) {
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
  if (!rawUrl && !token) return undefined;
  if (!rawUrl) throw new ConfigError("Missing --url (or TRIPEZGO_URL)");
  if (!token) throw new ConfigError("Missing --token (or TRIPEZGO_TOKEN)");

  return { baseUrl: normalizeBaseUrl(rawUrl), token };
}

/** Accepts `IP:PORT`, `http://IP:PORT`, or the full `http://IP:PORT/mcp` the app shows for direct clients. */
export function normalizeBaseUrl(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ConfigError(`Not a valid URL: ${raw}`);
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

const PRIVATE_RANGES_TEXT = "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, or Tailscale 100.64.0.0/10";

/** A dotted quad with no leading zeros, so `010.0.0.1`, `0xc0.…` and `3232235777` are never read as something else. */
function parseIPv4Literal(host: string): number[] | undefined {
  const match = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(host);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function isPrivateIPv4([a, b]: number[], allowLoopback: boolean): boolean {
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (allowLoopback && a === 127)
  );
}

/**
 * The address `connect` may reach: a literal IPv4 on a private network (the iPhone's Wi-Fi) or Tailscale — never a
 * hostname, a public address, loopback or IPv6. A prompt-injected AI could otherwise point the bridge, and the
 * key with it, anywhere. Checked on the text as given, before any URL parsing normalizes odd spellings.
 * `allowLoopback` is for tests that stand a fake app up on this machine.
 */
export function assertPrivateAddress(raw: string, options: { allowLoopback?: boolean } = {}): void {
  const reject = (why: string): never => {
    throw new ConfigError(
      `${why}. TripEZGo connects only to a literal IPv4 address on a private network (${PRIVATE_RANGES_TEXT}), ` +
        "the one the iPhone shows; hostnames and public addresses are refused on purpose",
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
