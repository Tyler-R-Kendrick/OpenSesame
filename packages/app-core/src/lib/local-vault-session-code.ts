/** Join-code alphabet and unbiased minting, kept apart from ledger rules. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomIndex(max: number): number {
  if (!Number.isInteger(max) || max <= 0)
    throw new Error("randomIndex needs a positive bound");
  const limit = Math.floor(2 ** 32 / max) * max;
  const buf = new Uint32Array(1);
  const view = new DataView(buf.buffer);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = view.getUint32(0);
  } while (value >= limit);
  return value % max;
}

export function mintSessionCode(): string {
  return Array.from(
    { length: 6 },
    () => CODE_ALPHABET[randomIndex(CODE_ALPHABET.length)],
  ).join("");
}
