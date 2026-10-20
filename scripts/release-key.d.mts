import type { KeyObject } from "node:crypto";

export function rawPublicKey(privateKey: KeyObject): Buffer;
export function keyIdOf(publicKey: Uint8Array): Buffer;
export function minisignPublicKey(privateKey: KeyObject): string;
