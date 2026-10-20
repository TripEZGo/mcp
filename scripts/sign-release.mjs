// Signs a release tarball, minisign-compatible (prehashed "ED"): writes <tarball>.minisig next to it.
// Usage: TRIPEZGO_RELEASE_KEY=<private-key-file> node scripts/sign-release.mjs <tarball> [trusted comment]
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { keyIdOf, rawPublicKey } from "./release-key.mjs";

const [tarball, comment] = process.argv.slice(2);
const keyFile = process.env.TRIPEZGO_RELEASE_KEY;
if (!tarball || !keyFile) {
  console.error("Usage: TRIPEZGO_RELEASE_KEY=<private-key-file> node scripts/sign-release.mjs <tarball> [trusted comment]");
  process.exit(2);
}

const privateKey = createPrivateKey(readFileSync(keyFile));
const keyId = keyIdOf(rawPublicKey(privateKey));
const signature = sign(null, createHash("blake2b512").update(readFileSync(tarball)).digest(), privateKey);
const trusted = comment ?? `file:${basename(tarball)}`;
const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(trusted, "utf8")]), privateKey);

writeFileSync(
  `${tarball}.minisig`,
  [
    "untrusted comment: TripEZGo release signature",
    Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64"),
    `trusted comment: ${trusted}`,
    globalSignature.toString("base64"),
    "",
  ].join("\n"),
);
console.log(`${tarball}.minisig`);
