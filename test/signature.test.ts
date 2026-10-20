import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RELEASE_PUBLIC_KEY } from "../src/launcherCore.js";
import { SignatureError, parsePublicKey, verifyMinisign } from "../src/signature.js";
import { testKey } from "./signing.js";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const bytes = Buffer.from("the release tarball");

describe("verifyMinisign", () => {
  const key = testKey();
  const signature = key.sign(bytes, "file:release.tar.gz");

  it("accepts a file the release script signed", () => {
    expect(() => verifyMinisign(bytes, signature, key.publicKey)).not.toThrow();
  });

  it("rejects a tampered file", () => {
    expect(() => verifyMinisign(Buffer.from("the release tarbalL"), signature, key.publicKey)).toThrow(/does not match/);
  });

  it("rejects a signature made by another key", () => {
    expect(() => verifyMinisign(bytes, testKey().sign(bytes), key.publicKey)).toThrow(/different key/);
  });

  it("rejects a tampered trusted comment", () => {
    const forged = signature.replace("trusted comment: file:release.tar.gz", "trusted comment: file:other.tar.gz");
    expect(() => verifyMinisign(bytes, forged, key.publicKey)).toThrow(/trusted comment was altered/);
  });

  it("rejects a flipped signature byte, a truncated file and garbage", () => {
    const lines = signature.split("\n");
    const raw = Buffer.from(lines[1], "base64");
    raw[40] ^= 1;
    lines[1] = raw.toString("base64");
    expect(() => verifyMinisign(bytes, lines.join("\n"), key.publicKey)).toThrow(SignatureError);
    expect(() => verifyMinisign(bytes, signature.split("\n").slice(0, 2).join("\n"), key.publicKey)).toThrow(/malformed/);
    expect(() => verifyMinisign(bytes, "", key.publicKey)).toThrow(/malformed/);
  });

  it("rejects a public key that is not a minisign key", () => {
    expect(() => parsePublicKey("AAAA")).toThrow(SignatureError);
  });

  it("the hard-coded release key parses", () => {
    expect(parsePublicKey(RELEASE_PUBLIC_KEY).key).toHaveLength(32);
  });
});

describe("release scripts", () => {
  it("gen-release-key writes a 600 private key, prints only the public key, and never overwrites", () => {
    const file = join(mkdtempSync(join(tmpdir(), "tripezgo-keygen-")), "k.key");
    const out = execFileSync(process.execPath, [join(SCRIPTS, "gen-release-key.mjs"), file], { encoding: "utf8" }).trim();
    expect(parsePublicKey(out).key).toHaveLength(32);
    expect(out).not.toContain("PRIVATE");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    writeFileSync(file, "keep me");
    expect(() => execFileSync(process.execPath, [join(SCRIPTS, "gen-release-key.mjs"), file], { stdio: "pipe" })).toThrow();
    expect(existsSync(file)).toBe(true);
  });

  it("sign-release needs the key path from TRIPEZGO_RELEASE_KEY", () => {
    const env = { ...process.env };
    delete env.TRIPEZGO_RELEASE_KEY;
    expect(() => execFileSync(process.execPath, [join(SCRIPTS, "sign-release.mjs"), "x.tar.gz"], { env, stdio: "pipe" })).toThrow(
      /TRIPEZGO_RELEASE_KEY/,
    );
  });
});
