// New writes must include a complete v2 wrapped-DEK header and payload tag.
// This checks transport structure; browser crypto gates verify authentication.
import { z } from "zod";

function envelope(value, prefix, encoding, minimum) {
  const text = z.string().safeParse(value);
  if (!text.success || !text.data.startsWith(prefix)) return false;
  const payload = text.data.slice(prefix.length);
  const alphabet =
    encoding === "base64url" ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9+/]+={0,2}$/;
  if (!alphabet.test(payload)) return false;
  const decoded = Buffer.from(payload, encoding);
  return (
    decoded.byteLength >= minimum && decoded.toString(encoding) === payload
  );
}

// XChaCha: nonce24 + wrappedDEK48 + nonce24 + tag16.
export function isRecordRestEnvelope(value) {
  return envelope(value, "osr2.", "base64url", 112);
}

// AES-GCM: nonce12 + wrappedDEK48 + nonce12 + tag16.
export function isClientRestEnvelope(value) {
  return envelope(value, "osc2.", "base64", 88);
}
