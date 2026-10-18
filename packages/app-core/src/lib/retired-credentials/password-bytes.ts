/** Bounded exact scalar UTF-8 input; no KDF is loaded during validation. */
export const MAX_PASSWORD_BYTES = 4096;
/** Caller owns the returned bytes. Reject before allocating an encoding. */
export function passwordBytes(password: string): Uint8Array {
  if (!password.length || password.length > MAX_PASSWORD_BYTES)
    throw new Error("Invalid retired credential.");
  let length = 0;
  for (let i = 0; i < password.length; i++) {
    const unit = password.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = password.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error("Invalid retired credential.");
      i++;
      length += 4;
    } else {
      if (unit >= 0xdc00 && unit <= 0xdfff)
        throw new Error("Invalid retired credential.");
      length += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (length > MAX_PASSWORD_BYTES)
      throw new Error("Invalid retired credential.");
  }
  return new TextEncoder().encode(password);
}
