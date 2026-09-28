/**
 * base64url without padding (RFC 4648 §5), for live-session links and codes
 * (ADR 0150). Core: the door reads a link before the capability loads.
 */

export function toB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromB64url(raw: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(raw)) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1)
      bytes[at] = binary.charCodeAt(at);
    return bytes;
  } catch {
    return null;
  }
}
