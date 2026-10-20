// Shared by gen-release-key.mjs and sign-release.mjs: the minisign key id and public-key line of an Ed25519 key.
import { createHash, createPublicKey } from "node:crypto";

/** Raw 32-byte public key of a Node KeyObject. */
export function rawPublicKey(privateKey) {
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32);
}

/** The key id is derived from the public key, so the signer and the printed public key always agree. */
export function keyIdOf(publicKey) {
  return createHash("sha256").update(publicKey).digest().subarray(0, 8);
}

/** base64("Ed" | keyId | publicKey): the line of a minisign `.pub` file, and what launcherCore.ts hard-codes. */
export function minisignPublicKey(privateKey) {
  const key = rawPublicKey(privateKey);
  return Buffer.concat([Buffer.from("Ed"), keyIdOf(key), key]).toString("base64");
}
