/** Shared base64 helpers for alert packages (no secrets in logs). */

export { b64ToBytes, bytesToB64 } from "@opensesame/vault-core/bytes.js";

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
