import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * minisign-compatible Ed25519 verification, on Node's own crypto (no dependency, so it fits the zero-dependency
 * launcher). Public key: base64 of `"Ed" | keyId(8) | publicKey(32)`. Signature file (`.minisig`):
 *
 *     untrusted comment: …
 *     base64("Ed" or "ED" | keyId(8) | signature(64))      "ED" signs BLAKE2b-512(message), "Ed" the message
 *     trusted comment: …
 *     base64(globalSignature(64))                          signs signature(64) | trustedComment
 */

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 key bytes follow. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const TRUSTED_COMMENT = "trusted comment: ";

export class SignatureError extends Error {}

export interface ParsedPublicKey {
  keyId: Buffer;
  key: Buffer;
}

export function parsePublicKey(base64: string): ParsedPublicKey {
  const raw = Buffer.from(base64.trim(), "base64");
  if (raw.length !== 42 || raw.toString("latin1", 0, 2) !== "Ed") throw new SignatureError("not a minisign public key");
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}

/** Throws `SignatureError` saying why, unless `signatureFile` is a valid signature of `message` by `publicKey`. */
export function verifyMinisign(message: Uint8Array, signatureFile: string, publicKey: string): void {
  const pub = parsePublicKey(publicKey);
  const lines = signatureFile.split(/\r?\n/);
  if (lines.length < 4 || !lines[0].startsWith("untrusted comment:") || !lines[2].startsWith(TRUSTED_COMMENT)) {
    throw new SignatureError("the signature file is malformed");
  }
  const sig = Buffer.from(lines[1].trim(), "base64");
  const globalSig = Buffer.from(lines[3].trim(), "base64");
  if (sig.length !== 74 || globalSig.length !== 64) throw new SignatureError("the signature file is malformed");
  const algorithm = sig.toString("latin1", 0, 2);
  if (algorithm !== "Ed" && algorithm !== "ED") throw new SignatureError("unknown signature algorithm");
  if (!sig.subarray(2, 10).equals(pub.keyId)) throw new SignatureError("signed with a different key");

  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub.key]), format: "der", type: "spki" });
  const signed = algorithm === "ED" ? createHash("blake2b512").update(message).digest() : Buffer.from(message);
  if (!verify(null, signed, key, sig.subarray(10))) throw new SignatureError("the signature does not match the file");
  const trusted = Buffer.from(lines[2].slice(TRUSTED_COMMENT.length), "utf8");
  if (!verify(null, Buffer.concat([sig.subarray(10), trusted]), key, globalSig)) {
    throw new SignatureError("the trusted comment was altered");
  }
}
