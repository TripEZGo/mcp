import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { minisignPublicKey } from "../scripts/release-key.mjs";

const SIGN_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sign-release.mjs");

export interface TestKey {
  /** minisign public-key line, what `RELEASE_PUBLIC_KEY` holds in production. */
  publicKey: string;
  /** Path of the PEM private key, what `TRIPEZGO_RELEASE_KEY` points at. */
  keyFile: string;
  /** Signs bytes with the real `scripts/sign-release.mjs`; returns the `.minisig` text. */
  sign: (bytes: Uint8Array, comment?: string) => string;
}

/** A throwaway release key, signing through the real release script. */
export function testKey(): TestKey {
  const dir = mkdtempSync(join(tmpdir(), "tripezgo-sign-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyFile = join(dir, "release.key");
  writeFileSync(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  return {
    publicKey: minisignPublicKey(privateKey),
    keyFile,
    sign(bytes, comment) {
      const tarball = join(dir, "release.tar.gz");
      writeFileSync(tarball, bytes);
      execFileSync(process.execPath, [SIGN_SCRIPT, tarball, ...(comment ? [comment] : [])], {
        env: { ...process.env, TRIPEZGO_RELEASE_KEY: keyFile },
        stdio: "pipe",
      });
      return readFileSync(`${tarball}.minisig`, "utf8");
    },
  };
}
