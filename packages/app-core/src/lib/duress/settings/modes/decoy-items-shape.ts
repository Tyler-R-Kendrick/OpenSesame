/**
 * The plan "Decoy with everyday items" seals, and the one reading of it.
 *
 * The mode writes it at arming; the runner reads it at unlock. Both go through
 * this file, so what a sheet accepts, what is sealed and what unlock will add
 * cannot drift. The reader is closed: any extra key, any count or length out of
 * range, any non-string, and the whole body is no plan.
 */

/** Items the decoy holds, and how long a title may be. */
export const DECOY_ITEM_LIMITS = {
  min: 3,
  max: 12,
  maxTitle: 40,
  /** A generated password; a body whose secret is shorter was not ours. */
  minSecret: 12,
  maxSecret: 64,
} as const;

export type DecoyItem = Readonly<{ title: string; secret: string }>;
export type DecoyItemsBody = Readonly<{ items: readonly DecoyItem[] }>;

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A title as it will be shown: one line of plain text, spaces collapsed. */
export function cleanTitle(line: string): string {
  return line.replace(CONTROLS, " ").replace(/\s+/gu, " ").trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function readItem(value: unknown): DecoyItem | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ["title", "secret"])) {
    return null;
  }
  const { title, secret } = value;
  if (typeof title !== "string" || typeof secret !== "string") return null;
  if (title.length === 0 || title.length > DECOY_ITEM_LIMITS.maxTitle) {
    return null;
  }
  if (title !== cleanTitle(title)) return null;
  if (
    secret.length < DECOY_ITEM_LIMITS.minSecret ||
    secret.length > DECOY_ITEM_LIMITS.maxSecret ||
    CONTROL.test(secret)
  ) {
    return null;
  }
  return { title, secret };
}

/** The items of a sealed body, or nothing: a body that is not exactly ours is not run. */
export function readDecoyItemsBody(body: unknown): DecoyItem[] | null {
  if (!isPlainObject(body) || !hasExactKeys(body, ["items"])) return null;
  const { items } = body;
  if (
    !Array.isArray(items) ||
    items.length < DECOY_ITEM_LIMITS.min ||
    items.length > DECOY_ITEM_LIMITS.max
  ) {
    return null;
  }
  const read: DecoyItem[] = [];
  for (const entry of items as unknown[]) {
    const item = readItem(entry);
    if (!item) return null;
    read.push(item);
  }
  return read;
}
