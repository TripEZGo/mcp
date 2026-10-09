export const USAGE = `Usage: npx -y github:TripEZGo/mcp --url http://IP:PORT --token=TOKEN

Both values are shown on the iPhone, on the TripEZGo "Connect computer AI" page.
They can also come from the environment: TRIPEZGO_URL, TRIPEZGO_TOKEN.`;
export class ConfigError extends Error {
}
const KNOWN_FLAGS = ["url", "token"];
/** `--url` / `--token`, alone or as `--url=…` / `--token=…`. */
function isKnownFlag(arg) {
    return KNOWN_FLAGS.some((name) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}
/** Reads `--url` / `--token` (flags win) or `TRIPEZGO_URL` / `TRIPEZGO_TOKEN`. */
export function parseConfig(argv, env) {
    const flags = new Map();
    const set = (name, value) => {
        // A second value would silently win over the first; say so instead.
        if (flags.has(name))
            throw new ConfigError(`--${name} given more than once`);
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
    const rawUrl = (flags.get("url") ?? env.TRIPEZGO_URL ?? "").trim();
    const token = (flags.get("token") ?? env.TRIPEZGO_TOKEN ?? "").trim();
    if (!rawUrl)
        throw new ConfigError("Missing --url (or TRIPEZGO_URL)");
    if (!token)
        throw new ConfigError("Missing --token (or TRIPEZGO_TOKEN)");
    return { baseUrl: normalizeBaseUrl(rawUrl), token };
}
/** Accepts `IP:PORT`, `http://IP:PORT`, or the full `http://IP:PORT/mcp` the app shows for direct clients. */
export function normalizeBaseUrl(raw) {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    let url;
    try {
        url = new URL(withScheme);
    }
    catch {
        throw new ConfigError(`Not a valid URL: ${raw}`);
    }
    const path = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
    return `${url.protocol}//${url.host}${path}`;
}
