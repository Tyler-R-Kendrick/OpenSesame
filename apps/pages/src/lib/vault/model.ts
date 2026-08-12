/** Vault item model. Everything here lives inside the sealed body — never in plaintext storage. */

export type ItemKind = "login" | "passkey" | "card" | "secret" | "note";

export type UriMatch = "domain" | "host" | "exact" | "never";

export type LoginUri = {
  /** Stable across edits so the editor can key rows by identity, not position. */
  id: string;
  uri: string;
  match: UriMatch;
};

export type CustomField = {
  id: string;
  name: string;
  value: string;
  hidden: boolean;
};

type BaseItem = {
  id: string;
  kind: ItemKind;
  name: string;
  folderId: string | null;
  favorite: boolean;
  notes: string;
  fields: CustomField[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Set on items created by "load sample vault" so they can be told apart and purged. */
  sample?: boolean;
};

export type LoginItem = BaseItem & {
  kind: "login";
  username: string;
  password: string;
  /** Base32 TOTP seed, or an otpauth:// URI. Empty when the login has no 2FA. */
  totp: string;
  uris: LoginUri[];
  /** ISO date the password itself last changed — drives the health report. */
  passwordChangedAt: string;
};

export type PasskeyItem = BaseItem & {
  kind: "passkey";
  rpId: string;
  username: string;
  credentialIdB64: string;
  publicKeyB64: string;
  /** Where the private key actually lives. The vault never holds it. */
  authenticator: "platform" | "cross-platform";
  /** True when this credential can unlock the vault via the WebAuthn PRF extension. */
  unlocksVault: boolean;
};

export type CardItem = BaseItem & {
  kind: "card";
  cardholder: string;
  brand: string;
  number: string;
  expMonth: string;
  expYear: string;
  code: string;
};

export type CapabilityGrant = {
  /** Stable across edits so the editor can key rows by identity, not position. */
  id: string;
  action: string;
  resource: string;
};

export type SecretItem = BaseItem & {
  kind: "secret";
  value: string;
  /** Agents may only ever act within this ceiling; it never widens. */
  ceiling: CapabilityGrant[];
  /** Agent identifiers permitted to request a grant against this secret. */
  grantees: string[];
  /** ConnectionRef the Host plane uses to invoke with this secret. */
  connectionRef: string;
};

export type NoteItem = BaseItem & {
  kind: "note";
};

export type VaultItem =
  | LoginItem
  | PasskeyItem
  | CardItem
  | SecretItem
  | NoteItem;

export type Folder = {
  id: string;
  name: string;
  createdAt: string;
};

export type VaultBody = {
  v: 1;
  items: VaultItem[];
  folders: Folder[];
  /**
   * Writes so far. Sealed with the body, so it cannot be edited without the vault
   * key, and compared against the header on unlock: a body that has gone
   * backwards is one restored from an older copy, not the vault as last left.
   */
  rev?: number;
};

export const KIND_LABEL: Record<ItemKind, string> = {
  login: "Login",
  passkey: "Passkey",
  card: "Card",
  secret: "Agent secret",
  note: "Secure note",
};

export const KIND_PLURAL: Record<ItemKind, string> = {
  login: "Logins",
  passkey: "Passkeys",
  card: "Cards",
  secret: "Agent secrets",
  note: "Secure notes",
};

export function newId(): string {
  return crypto.randomUUID();
}

export function emptyBody(): VaultBody {
  return { v: 1, items: [], folders: [], rev: 0 };
}

export function newUri(uri = "", match: UriMatch = "domain"): LoginUri {
  return { id: newId(), uri, match };
}

export function newGrant(action = "", resource = ""): CapabilityGrant {
  return { id: newId(), action, resource };
}

function base(kind: ItemKind, name: string): BaseItem {
  const now = new Date().toISOString();
  return {
    id: newId(),
    kind,
    name,
    folderId: null,
    favorite: false,
    notes: "",
    fields: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function createItem(kind: ItemKind, name = ""): VaultItem {
  const b = base(kind, name);
  switch (kind) {
    case "login":
      return {
        ...b,
        kind: "login",
        username: "",
        password: "",
        totp: "",
        uris: [],
        passwordChangedAt: b.createdAt,
      };
    case "passkey":
      return {
        ...b,
        kind: "passkey",
        rpId: "",
        username: "",
        credentialIdB64: "",
        publicKeyB64: "",
        authenticator: "platform",
        unlocksVault: false,
      };
    case "card":
      return {
        ...b,
        kind: "card",
        cardholder: "",
        brand: "",
        number: "",
        expMonth: "",
        expYear: "",
        code: "",
      };
    case "secret":
      return {
        ...b,
        kind: "secret",
        value: "",
        ceiling: [],
        grantees: [],
        connectionRef: "",
      };
    case "note":
      return { ...b, kind: "note" };
  }
}

/** Subtitle shown in the item list — never a secret value. */
export function itemSubtitle(item: VaultItem): string {
  switch (item.kind) {
    case "login":
      return item.username || hostOf(item.uris[0]?.uri) || "No username";
    case "passkey":
      return item.username ? `${item.username} · ${item.rpId}` : item.rpId;
    case "card":
      return item.number ? `•••• ${item.number.slice(-4)}` : item.brand;
    case "secret":
      return item.connectionRef || `${item.ceiling.length} capabilities`;
    case "note": {
      const firstLine = item.notes.split("\n")[0]?.slice(0, 64);
      if (firstLine) return firstLine;
      // An imported identity or typed note often carries everything in fields
      // and nothing in the note body, which is not the same as being empty.
      if (item.fields.length > 0) {
        return `${item.fields.length} ${item.fields.length === 1 ? "field" : "fields"}`;
      }
      return "Empty note";
    }
  }
}

export function hostOf(uri: string | undefined): string {
  if (!uri) return "";
  try {
    return new URL(uri.includes("://") ? uri : `https://${uri}`).host;
  } catch {
    return "";
  }
}

/**
 * Only http(s) may become a real link. An imported item could carry a
 * `javascript:` or `data:` URI, which would run in the unlocked vault origin.
 */
export function browsableUrl(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri.includes("://") ? uri : `https://${uri}`);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Stable first letter used by the list avatar when no favicon is available. */
export function initialOf(item: VaultItem): string {
  const source = item.name || itemSubtitle(item) || "?";
  return source.trim().charAt(0).toUpperCase() || "?";
}

export function searchMatches(item: VaultItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack: string[] = [item.name, KIND_LABEL[item.kind], item.notes];
  if (item.kind === "login") {
    haystack.push(item.username, ...item.uris.map((u) => u.uri));
  }
  if (item.kind === "passkey") haystack.push(item.username, item.rpId);
  if (item.kind === "card") haystack.push(item.brand, item.cardholder);
  if (item.kind === "secret") {
    haystack.push(item.connectionRef, ...item.grantees);
  }
  for (const field of item.fields) {
    if (!field.hidden) haystack.push(field.name, field.value);
    else haystack.push(field.name);
  }
  return haystack.some((value) => value.toLowerCase().includes(q));
}

export function sortItems(items: VaultItem[]): VaultItem[] {
  return [...items].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
