/** Canonical 32-byte identifier codec; no owner schema or registry dependency. */
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core";
const PREFIX = "oscanary:v1:";
export function decodePresentedId(id: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id))
    throw new Error("Invalid controlled identifier.");
  const bytes = b64ToBytes(`${id.replaceAll("-", "+").replaceAll("_", "/")}=`);
  if (bytes.length !== 32 || encodePresentedId(bytes) !== id)
    throw new Error("Invalid controlled identifier.");
  return bytes;
}
export function encodePresentedId(bytes: Uint8Array): string {
  if (bytes.length !== 32)
    throw new Error("Controlled identifiers require 32 bytes.");
  return bytesToB64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function parseControlledCanaryReference(ref: string): string | null {
  if (!ref.startsWith(PREFIX)) return null;
  const id = ref.slice(PREFIX.length);
  decodePresentedId(id);
  return id;
}
export function controlledCanaryReference(id: string): string {
  decodePresentedId(id);
  return PREFIX + id;
}
