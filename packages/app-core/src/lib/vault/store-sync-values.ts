/**
 * Which of a built-in kind's named properties ride in a store entry, and how
 * (ADR 0037 §6, ADR 0087). Line one holds the property the kind promotes —
 * the one the first bridge already chose, so an old manifest still lands it
 * in the right place — and format 2's `values` carries every other one, so a
 * card, a certificate, a passkey or a drop comes back as itself.
 *
 * Every value read back is checked against the property's shape before it
 * reaches an item: a manifest is a file somebody handed the Import sheet.
 */
import {
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type CustomField,
  type ItemKind,
  type LegacyItemKind,
  type VaultItem,
  accountFilePassword,
  createItem,
  newGrant,
  newId,
} from "@opensesame/vault-core";
import { graftAccountFormatOne } from "./store-sync-account.js";
import { credentialLineOne } from "./store-sync-credential.js";
import type { StoreCustomField } from "./store-sync-entry.js";

type Check = (value: JsonValue) => boolean;

const text: Check = isString;
const flag: Check = isBoolean;
const count: Check = (value) => isNumber(value) && Number.isFinite(value);
const texts: Check = (value) => Array.isArray(value) && value.every(isString);
const textOrNull: Check = (value) => value === null || isString(value);

function oneOf(...allowed: readonly string[]): Check {
  return (value) => isString(value) && allowed.includes(value);
}

function isGrant(value: JsonValue): boolean {
  return (
    isJsonObject(value) && isString(value.action) && isString(value.resource)
  );
}

const grants: Check = (value) => Array.isArray(value) && value.every(isGrant);

function isKeptCopy(value: JsonValue): boolean {
  if (!isJsonObject(value)) return false;
  if (value.kind === "text") return isString(value.text);
  return (
    value.kind === "file" &&
    isString(value.name) &&
    isString(value.contentType) &&
    isString(value.dataB64)
  );
}

const ROTATION = {
  supersededById: text,
  retiredAt: textOrNull,
  reenrollState: oneOf("none", "new-enrolled", "old-retired"),
} satisfies Record<string, Check>;

/**
 * The property each kind promotes to line one. `null` for a kind whose
 * definition names no secret (`native.secret`): a drop's bearer token is not
 * something `pass show` should present as the password. An account has no
 * such property: its line one is its first password method's, when that is
 * kept in the clear (`store-sync-account.ts`).
 */
export const LINE_ONE = {
  account: null,
  passkey: "credentialIdB64",
  card: "number",
  secret: "value",
  note: "notes",
  certificate: "privateKeyPem",
  drop: null,
} satisfies Record<LegacyItemKind, string | null>;

/**
 * Every named property format 2 carries in `values`, beyond line one and the
 * keys the first format already gave their own place (a secret's
 * ConnectionRef). An account's values are all its own: `store-sync-account.ts`.
 *
 * A passkey's `unlocksVault` is left out on purpose: it is a claim about the
 * vault that enrolled the credential, and no other vault can inherit it
 * (`lib/vault/import/merge.ts` resets it for the same reason).
 */
const NAMED = {
  account: {},
  passkey: {
    rpId: text,
    username: text,
    publicKeyB64: text,
    authenticator: oneOf("platform", "cross-platform"),
    privateKeyPkcs8B64: text,
    cosePublicKeyB64: text,
    signCount: count,
    userHandleB64: text,
    discoverable: flag,
    alg: count,
    transports: texts,
    custody: oneOf("vault", "external"),
    provenance: oneOf("imported", "generated", "recorded"),
    importedFrom: text,
    duplicateOfExternal: flag,
    ...ROTATION,
  },
  card: {
    cardholder: text,
    brand: text,
    expMonth: text,
    expYear: text,
    code: text,
  },
  secret: { ceiling: grants, grantees: texts },
  note: {},
  certificate: {
    commonName: text,
    dnsNames: text,
    ipAddrs: text,
    ttlHours: text,
    certificatePem: text,
    caPem: text,
    serial: text,
    notAfter: text,
  },
  drop: {
    state: oneOf("pending", "consumed", "expired"),
    claimId: text,
    bearerToken: text,
    expiresAt: text,
    keptCopy: isKeptCopy,
  },
} satisfies Record<LegacyItemKind, Record<string, Check>>;

/**
 * What a first-format entry (no `v`) said about each kind faithfully. A merge
 * of one grafts only these onto the item already at its path, so re-importing
 * an old manifest never erases what that format could not carry.
 */
const FORMAT_ONE = {
  account: [],
  secret: ["value", "connectionRef", "notes"],
  note: ["notes"],
  typed: ["typeId", "values", "notes"],
  credential: [],
  passkey: ["credentialIdB64", "notes"],
  card: ["number"],
  certificate: ["privateKeyPem"],
  drop: [],
} satisfies Record<ItemKind, readonly string[]>;

/** Properties a fresh item takes from the clock (`createItem`). */
const STAMPED = new Set(["expiresAt"]);

const LEGACY_KINDS: readonly LegacyItemKind[] = [
  "account",
  "passkey",
  "card",
  "secret",
  "note",
  "certificate",
  "drop",
];

/**
 * The built-in kind a trailer names, or an account for anything else: a
 * trailer that says `login`, or nothing, is a login written before ADR 0172,
 * and reads as the account it becomes.
 */
export function legacyKindOf(kind: string | undefined): LegacyItemKind {
  return LEGACY_KINDS.find((candidate) => candidate === kind) ?? "account";
}

/** Line one is one line: `pass` reserves it, and `pass seal` splits on `\n`. */
export function isOneLine(value: string): boolean {
  return !/[\r\n]/u.test(value);
}

function propsOf(item: VaultItem): JsonObject {
  return overlapCast(item);
}

/** The text an item promotes to line one, whatever its line breaks. */
export function lineOneValue(item: VaultItem): string {
  if (item.kind === "typed") return "";
  if (item.kind === "credential") return credentialLineOne(item.method);
  if (item.kind === "account") return accountFilePassword(item);
  const key = LINE_ONE[item.kind];
  const value = key === null ? undefined : propsOf(item)[key];
  return isString(value) ? value : "";
}

function withoutIds(key: string, value: JsonValue): JsonValue {
  if (key !== "ceiling" || !Array.isArray(value)) return value;
  return value.map((grant) =>
    isJsonObject(grant)
      ? { action: grant.action ?? "", resource: grant.resource ?? "" }
      : grant,
  );
}

/**
 * A built-in item's named properties for `values`: every one that differs
 * from what a fresh item of its kind would hold, so a reader starting from
 * that fresh item ends up with exactly this one. A property a fresh item
 * stamps with the clock is always written: its default is not a fixed value,
 * so leaving it out would make the same item save two different entries.
 * Line one joins them when it holds a line break, since line one cannot.
 */
export function namedValues(item: VaultItem): JsonObject | undefined {
  if (item.kind === "typed" || item.kind === "credential") return undefined;
  const props = propsOf(item);
  const fresh = propsOf(createItem(item.kind, item.name));
  const keys = Object.keys(NAMED[item.kind]);
  const lineOne = LINE_ONE[item.kind];
  if (
    lineOne !== null &&
    item.kind !== "note" &&
    !isOneLine(lineOneValue(item))
  )
    keys.push(lineOne);
  const out: MutableJsonObject = {};
  for (const key of keys) {
    const value = props[key];
    if (value === undefined) continue;
    const same = JSON.stringify(value) === JSON.stringify(fresh[key]);
    if (same && !STAMPED.has(key)) continue;
    out[key] = withoutIds(key, value);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function withIds(key: string, value: JsonValue): JsonValue {
  if (key !== "ceiling" || !Array.isArray(value)) return value;
  return value.map((grant) => {
    const { action, resource } = overlapCast(grant);
    return newGrant(
      isString(action) ? action : "",
      isString(resource) ? resource : "",
    );
  });
}

/**
 * Lay `values` from a trailer onto a built-in item. A key the kind does not
 * name, or a value of the wrong shape, is dropped rather than trusted.
 */
export function applyNamedValues(
  item: VaultItem,
  values: JsonValue | undefined,
): void {
  if (item.kind === "typed" || item.kind === "credential") return;
  if (!isJsonObject(values)) return;
  const checks = new Map<string, Check>(Object.entries(NAMED[item.kind]));
  const lineOne = LINE_ONE[item.kind];
  if (lineOne !== null && item.kind !== "note") checks.set(lineOne, text);
  const target: MutableJsonObject = overlapCast(item);
  for (const [key, check] of checks) {
    const value = values[key];
    if (value === undefined || !check(value)) continue;
    target[key] = withIds(key, value);
  }
}

/** Custom fields as a trailer carries them, or nothing when there are none. */
export function customFieldsOut(
  fields: readonly CustomField[],
): StoreCustomField[] | undefined {
  if (fields.length === 0) return undefined;
  return fields.map(({ name, value, hidden }) => ({ name, value, hidden }));
}

/** Custom fields back from a trailer; a malformed one is dropped. */
export function customFieldsIn(value: JsonValue | undefined): CustomField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((field) => {
    if (!isJsonObject(field)) return [];
    const { name, value: fieldValue, hidden } = field;
    if (!isString(name) || !isString(fieldValue) || !isBoolean(hidden)) {
      return [];
    }
    return [{ id: newId(), name, value: fieldValue, hidden }];
  });
}

/**
 * What an import may never confer: a secret's agent ceiling, its grantees and
 * the ConnectionRef it answers for. A manifest carries them so the sealed
 * store keeps them, but authority is granted in its own ceremony, never by a
 * file (`lib/vault/import/merge.ts` clears them for the same reason). A new
 * item arrives with none; an existing one keeps its own.
 */
export function withoutConferredAuthority(
  incoming: VaultItem,
  current: VaultItem | null,
): VaultItem {
  if (incoming.kind !== "secret") return incoming;
  const own = current?.kind === "secret" ? current : null;
  return {
    ...incoming,
    ceiling: own ? own.ceiling : [],
    grantees: own ? own.grantees : [],
    connectionRef: own ? own.connectionRef : "",
  };
}

/**
 * The item a merge writes over `current`. A whole-item entry (format 2)
 * replaces its content; a first-format one grafts only what it carried. Either
 * way the item keeps its identity, its folder, its star and — for a passkey —
 * whether it unlocks this vault. A different kind is replaced outright; the
 * Import sheet declines that case before it gets here.
 */
export function graftOnto(
  current: VaultItem,
  incoming: VaultItem,
  whole: boolean,
): VaultItem {
  const kept = {
    id: current.id,
    createdAt: current.createdAt,
    folderId: current.folderId,
    favorite: current.favorite,
  };
  if (current.kind !== incoming.kind) return { ...incoming, ...kept };
  if (!whole && current.kind === "account" && incoming.kind === "account") {
    return { ...graftAccountFormatOne(current, incoming), ...kept };
  }
  if (whole) {
    const next: VaultItem = { ...incoming, ...kept };
    // A manifest never says which account a credential is bound to.
    if (next.kind === "credential" && current.kind === "credential") {
      next.accountId = current.accountId;
      next.order = current.order;
    }
    if (next.kind === "passkey" && current.kind === "passkey") {
      next.unlocksVault = current.unlocksVault;
    }
    return next;
  }
  const said: MutableJsonObject = {};
  const props = propsOf(incoming);
  for (const key of FORMAT_ONE[incoming.kind]) said[key] = props[key];
  return overlapCast({ ...current, ...said, ...kept });
}
