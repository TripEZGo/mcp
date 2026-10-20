import { createHmac } from "node:crypto";
import { Agent, request } from "node:https";

/** The cipher suite both ends pin: TLS 1.2, pre-shared key, AES-128-GCM. There are no certificates in PSK mode. */
export const PSK_CIPHER = "PSK-AES128-GCM-SHA256";
export const PSK_IDENTITY = "tripezgo";
const PSK_CONTEXT = "tripezgo tls psk v1";

/**
 * The 32-byte TLS pre-shared key: HMAC-SHA256(key = UTF-8 bytes of the connection key from the connect sentence,
 * data = UTF-8 "tripezgo tls psk v1"). The app derives the same bytes.
 */
export function derivePsk(connectionKey: string): Buffer {
  return createHmac("sha256", Buffer.from(connectionKey, "utf8")).update(PSK_CONTEXT, "utf8").digest();
}

/** The TLS options of the client agent. */
function pskClientOptions(connectionKey: string) {
  const psk = derivePsk(connectionKey);
  return {
    minVersion: "TLSv1.2" as const,
    maxVersion: "TLSv1.2" as const,
    ciphers: PSK_CIPHER,
    pskCallback: () => ({ psk, identity: PSK_IDENTITY }),
  };
}

/** The TCP connection came up but TLS did not: the phone's TripEZGo is too old (plain HTTP) or the key is wrong. */
export class TlsHandshakeError extends Error {
  constructor(cause: unknown) {
    super(`TLS handshake failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "TlsHandshakeError";
  }
}

const agents = new Map<string, Agent>();

function agentFor(connectionKey: string): Agent {
  let agent = agents.get(connectionKey);
  if (!agent) {
    agent = new Agent({
      keepAlive: true,
      ...pskClientOptions(connectionKey),
      // PSK mode has no certificate to check; the shared key is the authentication.
      checkServerIdentity: () => undefined,
    });
    agents.set(connectionKey, agent);
  }
  return agent;
}

/**
 * `fetch` for the phone: always TLS 1.2 + PSK, never plaintext. The PSK comes from the `Authorization: Bearer <key>`
 * header every request to the phone already carries. The URL's scheme is ignored. Resolves with a normal `Response`
 * (the body is read whole); a handshake failure rejects with `TlsHandshakeError`.
 */
export const phoneFetch = ((input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init.headers);
  const key = /^Bearer (.*)$/.exec(headers.get("authorization") ?? "")?.[1];
  if (key === undefined) return Promise.reject(new TypeError("phoneFetch needs the connection key as a Bearer token"));
  const signal = init.signal ?? undefined;
  const body =
    init.body === undefined || init.body === null ? undefined : typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array);

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    let tcpUp = false;
    let secured = false;
    const outHeaders: Record<string, string> = {};
    headers.forEach((value, name) => (outHeaders[name] = value));
    const req = request(
      {
        host: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: outHeaders,
        agent: agentFor(key),
        servername: "", // an IP literal; no SNI
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(name, v));
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          const status = res.statusCode ?? 0;
          const empty = status === 204 || status === 205 || status === 304;
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
        });
      },
    );
    req.on("socket", (socket) => {
      if (!socket.connecting) {
        // A reused keep-alive socket already finished its handshake.
        tcpUp = true;
        secured = true;
        return;
      }
      socket.once("connect", () => (tcpUp = true));
      socket.once("secureConnect", () => (secured = true));
    });
    req.on("error", (error) => {
      if (signal?.aborted) return reject(signal.reason);
      reject(tcpUp && !secured ? new TlsHandshakeError(error) : error);
    });
    signal?.addEventListener("abort", () => req.destroy(), { once: true });
    req.end(body);
  });
}) as typeof fetch;
