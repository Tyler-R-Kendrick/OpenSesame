import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

/** Per-attempt correlation id for TCP daemon calls (approval is single-use). */
export function ephemeralTerminalCorrelationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(sha256(bytes)).slice(0, 32);
}

/** @deprecated Use {@link ephemeralTerminalCorrelationId}; daemon derives UDS sessions. */
export function deriveTerminalSessionId(): string {
  return ephemeralTerminalCorrelationId();
}
