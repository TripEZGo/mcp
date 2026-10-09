import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Bridge } from "./bridge.js";

/**
 * Newline-delimited JSON-RPC on `input` → bridge → `output`, one message per line.
 * Lines are handled one at a time so `initialize` (and the session id it may bring) lands before anything after it.
 * Resolves once `input` ends and every pending line has been answered.
 */
export async function runStdio(input: Readable, output: Writable, bridge: Pick<Bridge, "handle">): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let chain: Promise<void> = Promise.resolve();
  for await (const line of lines) {
    chain = chain.then(async () => {
      const replies = await bridge.handle(line);
      for (const reply of replies) output.write(`${reply}\n`);
    });
  }
  await chain;
}
