/**
 * The candidate password, generated where it will be held (ADR 0076 §1): in the
 * owner's browser, from the platform's CSPRNG, and never anywhere else.
 */

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGIT = "23456789";
const SYMBOL = "!#$%&*+-=?@^_";
const CLASSES = [LOWER, UPPER, DIGIT, SYMBOL] as const;
const ALL = CLASSES.join("");

export const CANDIDATE_LENGTH = 28;

/** Uniform over `0..bound` by rejection, so no character is likelier than another. */
function below(bound: number, random: (bytes: Uint8Array) => Uint8Array) {
  const limit = 256 - (256 % bound);
  const one = new Uint8Array(1);
  for (;;) {
    const byte = random(one)[0] ?? 255;
    if (byte < limit) return byte % bound;
  }
}

export type RandomBytes = (bytes: Uint8Array) => Uint8Array;

/** A password with at least one of each class, shuffled, of `length` characters. */
export function generatePassword(
  random: RandomBytes = (bytes) => crypto.getRandomValues(bytes),
  length = CANDIDATE_LENGTH,
): string {
  if (length < CLASSES.length) throw new Error("password_too_short");
  const picked: string[] = CLASSES.map(
    (set) => set[below(set.length, random)] ?? "",
  );
  while (picked.length < length) {
    picked.push(ALL[below(ALL.length, random)] ?? "");
  }
  // Fisher-Yates, so the guaranteed characters are not always the first four.
  for (let index = picked.length - 1; index > 0; index -= 1) {
    const other = below(index + 1, random);
    const held = picked[index] ?? "";
    picked[index] = picked[other] ?? "";
    picked[other] = held;
  }
  return picked.join("");
}
