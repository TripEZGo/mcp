// Creates the release-signing Ed25519 key. Usage: node scripts/gen-release-key.mjs <private-key-file>
// Writes the private key (PKCS#8 PEM, mode 600) and prints ONLY the public key (minisign format), which goes
// into RELEASE_PUBLIC_KEY in src/launcherCore.ts. Refuses to overwrite an existing file.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { minisignPublicKey } from "./release-key.mjs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/gen-release-key.mjs <private-key-file>");
  process.exit(2);
}
if (existsSync(file)) {
  console.error(`${file} already exists; not overwriting it.`);
  process.exit(1);
}
const { privateKey } = generateKeyPairSync("ed25519");
writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
console.log(minisignPublicKey(privateKey));
