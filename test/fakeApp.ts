import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { assertPrivateAddress } from "../src/config.js";

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface FakeReply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export type FakeHandler = (request: RecordedRequest) => FakeReply;

/** A stand-in for the iPhone app's HTTP listener: records every request and answers with `handler`. */
export class FakeApp {
  readonly requests: RecordedRequest[] = [];
  handler: FakeHandler = () => ({ status: 500, body: "no handler" });
  private server: Server | undefined;

  async start(host = "127.0.0.1"): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://fake");
        const recorded: RecordedRequest = {
          method: req.method ?? "",
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body: Buffer.concat(chunks),
        };
        this.requests.push(recorded);
        const reply = this.handler(recorded);
        res.writeHead(reply.status, reply.headers ?? {});
        res.end(reply.body ?? "");
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, host, resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://${host}:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

/**
 * This machine's own address on a private network, or undefined. `connect` refuses loopback, so a test that goes
 * through the real CLI needs the fake app on an address the bridge accepts.
 */
export function privateLanIPv4(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      try {
        assertPrivateAddress(entry.address);
        return entry.address;
      } catch {
        // not a private address
      }
    }
  }
  return undefined;
}

export const json = (status: number, value: unknown, headers: Record<string, string> = {}): FakeReply => ({
  status,
  headers: { "Content-Type": "application/json", ...headers },
  body: typeof value === "string" ? value : JSON.stringify(value),
});

/** An address nothing listens on. */
export async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
