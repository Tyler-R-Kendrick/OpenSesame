/** Per-attempt correlation id for TCP daemon calls (approval is single-use). */
export async function ephemeralTerminalCorrelationId(): Promise<string> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** @deprecated Use {@link ephemeralTerminalCorrelationId}; daemon derives UDS sessions. */
export async function deriveTerminalSessionId(): Promise<string> {
  return await ephemeralTerminalCorrelationId();
}
