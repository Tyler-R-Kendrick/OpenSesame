import {
  DECOY_ITEM_LIMITS,
  type DecoyItem,
  cleanTitle,
} from "./decoy-items-shape.js";
import { itemLines } from "./inputs.js";
import type { DuressMode, DuressPlan } from "./mode.js";

/**
 * Generic titles written here, so the owner edits a plausible list. They are
 * ours, never derived from the vault: a starter that echoed real titles would
 * be a path from the vault to a screen shown under duress.
 */
const STARTER = [
  "Netflix",
  "Wi-Fi at home",
  "Library card",
  "Gym",
  "Spotify",
  "Electric bill",
] as const;

const SECRET_LENGTH = 20;
const ALPHABET =
  "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_.!@#";

/**
 * A random-looking password, drawn at arming so the decoy shows the same value
 * on every use. Rejection sampling keeps every character equally likely.
 */
export function randomDecoySecret(): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < SECRET_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(SECRET_LENGTH * 2));
    for (const byte of bytes) {
      if (byte < limit && out.length < SECRET_LENGTH) {
        out += ALPHABET[byte % ALPHABET.length];
      }
    }
  }
  return out;
}

/** One item per line, each with a secret of its own. Throws when the lines are not a decoy. */
function planFor(extras: Readonly<Record<string, string>>): DuressPlan {
  const titles = itemLines(extras.items ?? "").map(cleanTitle);
  if (
    titles.length < DECOY_ITEM_LIMITS.min ||
    titles.length > DECOY_ITEM_LIMITS.max ||
    titles.some(
      (title) =>
        title.length === 0 || title.length > DECOY_ITEM_LIMITS.maxTitle,
    )
  ) {
    throw new Error("decoy items out of range");
  }
  const items: DecoyItem[] = titles.map((title) => ({
    title,
    secret: randomDecoySecret(),
  }));
  return { effect: "decoy_items", body: { items } };
}

/** The decoy, holding the ordinary items the owner typed. */
export const DECOY_ITEMS = {
  id: "decoy_items",
  label: "Decoy with everyday items",
  opens: "a decoy vault holding only the items typed here",
  consent:
    "I understand this code opens a decoy holding only the items I typed here, never my vault, and it looks only as plausible as those items are.",
  presentation: "decoy",
  input: {
    kind: "items",
    id: "items",
    label: "Everyday items, one per line",
    min: DECOY_ITEM_LIMITS.min,
    max: DECOY_ITEM_LIMITS.max,
    maxLength: DECOY_ITEM_LIMITS.maxTitle,
    starter: STARTER,
  },
  plan: planFor,
} as const satisfies DuressMode;
