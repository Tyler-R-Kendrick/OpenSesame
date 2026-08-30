/** Vault item model. Everything here lives inside the sealed body — never in plaintext storage. */

export type ItemKind =
  | "login"
  | "passkey"
  | "card"
  | "secret"
  | "note"
  | "certificate"
  | "drop";

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
  supersededById?: string;
  retiredAt?: string | null;
  reenrollState?: ReenrollState;
};

export type PasskeyCustody = "vault" | "external";
export type PasskeyProvenance = "imported" | "generated" | "recorded";
export type ReenrollState = "none" | "new-enrolled" | "old-retired";

export type PasskeyItem = BaseItem & {
  kind: "passkey";
  rpId: string;
  username: string;
  credentialIdB64: string;
  publicKeyB64: string;
  /** Provider class presented to WebAuthn clients. */
  authenticator: "platform" | "cross-platform";
  /** True when this credential can unlock the vault via the WebAuthn PRF extension. */
  unlocksVault: boolean;
  /** PKCS#8 private key, base64; present only for vault custody. */
  privateKeyPkcs8B64?: string;
  /** COSE_Key public key, base64. */
  cosePublicKeyB64?: string;
  /** Synced passkeys use zero to avoid false clone detection across devices. */
  signCount?: number;
  userHandleB64?: string;
  discoverable?: boolean;
  /** COSE algorithm identifier; ES256 (-7) is the required baseline. */
  alg?: number;
  transports?: string[];
  /** Absent on legacy metadata-only items and therefore treated as external. */
  custody?: PasskeyCustody;
  provenance?: PasskeyProvenance;
  importedFrom?: string;
  duplicateOfExternal?: boolean;
  supersededById?: string;
  retiredAt?: string | null;
  reenrollState?: ReenrollState;
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
  /**
   * Optional grant metadata: the outer bound for any grant of this secret to
   * an agent. It only matters when granting the secret, and it never widens.
   */
  ceiling: CapabilityGrant[];
  /**
   * Optional grant metadata: agent identifiers permitted to request a grant.
   * It only matters when granting the secret to an agent.
   */
  grantees: string[];
  /** ConnectionRef the Host plane uses to invoke with this secret. */
  connectionRef: string;
};

export type NoteItem = BaseItem & {
  kind: "note";
};

/** Lifecycle of a drop record; terminal states are purged on the next read. */
export type DropState = "pending" | "consumed" | "expired";

/**
 * The payload a drop carried, kept only when the sharer checked *Keep a copy*.
 * Bytes are base64 so the record stays JSON-safe inside the vault body.
 */
export type DropKeptCopy =
  | { kind: "text"; text: string }
  | { kind: "file"; name: string; contentType: string; dataB64: string };

/**
 * A drop is a record of a one-time share in flight — never the payload itself
 * (ADR 0062). The bearer token is needed to poll the claim; it lives only
 * inside this sealed vault body.
 */
export type DropItem = BaseItem & {
  kind: "drop";
  state: DropState;
  claimId: string;
  bearerToken: string;
  /** ISO time the claim lapses; a lapsed pending drop is terminal. */
  expiresAt: string;
  keptCopy?: DropKeptCopy;
};

export type CertificateItem = BaseItem & {
  kind: "certificate";
  commonName: string;
  dnsNames: string;
  ipAddrs: string;
  ttlHours: string;
  certificatePem: string;
  privateKeyPem: string;
  caPem: string;
  serial: string;
  notAfter: string;
};

export type VaultItem =
  | LoginItem
  | PasskeyItem
  | CardItem
  | SecretItem
  | NoteItem
  | CertificateItem
  | DropItem;

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

export const KIND_LABEL = {
  login: "Login",
  passkey: "Passkey",
  card: "Card",
  secret: "Secret",
  note: "Secure note",
  certificate: "Certificate",
  drop: "Drop",
};

export const KIND_PLURAL = {
  login: "Logins",
  passkey: "Passkeys",
  card: "Cards",
  secret: "Secrets",
  note: "Secure notes",
  certificate: "Certificates",
  drop: "Drops",
};

export function newId(): string {
  return crypto.randomUUID();
}

export function emptyBody(): VaultBody {
  return { v: 1, items: [], folders: [], rev: 0 };
}

/** Deterministic, no-data-loss merge for two encrypted whole-vault snapshots. */
export function mergeVaultBodies(left: VaultBody, right: VaultBody): VaultBody {
  const items = new Map(left.items.map((item) => [item.id, item]));
  for (const incoming of right.items) {
    const current = items.get(incoming.id);
    if (!current || itemVersion(incoming) > itemVersion(current)) {
      items.set(incoming.id, incoming);
    }
  }
  const folders = new Map(left.folders.map((folder) => [folder.id, folder]));
  for (const incoming of right.folders) {
    const current = folders.get(incoming.id);
    if (!current || JSON.stringify(incoming) > JSON.stringify(current)) {
      folders.set(incoming.id, incoming);
    }
  }
  return {
    v: 1,
    items: [...items.values()],
    folders: [...folders.values()],
    rev: Math.max(left.rev ?? 0, right.rev ?? 0),
  };
}

function itemVersion(item: VaultItem): string {
  const changedAt =
    item.deletedAt && item.deletedAt > item.updatedAt
      ? item.deletedAt
      : item.updatedAt;
  return `${changedAt}\0${JSON.stringify(item)}`;
}

/** True only when OpenSesame has complete signing material for the passkey. */
export function isVaultCustodied(item: PasskeyItem): boolean {
  return item.custody === "vault" && Boolean(item.privateKeyPkcs8B64);
}

/** Legacy records and explicit external records cannot satisfy assertions. */
export function isForeignPasskey(item: PasskeyItem): boolean {
  return !isVaultCustodied(item);
}

export function isRetired(item: VaultItem): boolean {
  return "retiredAt" in item && Boolean(item.retiredAt);
}

/**
 * A drop record is disposable once its poll reached a terminal state or its
 * TTL lapsed — either way nothing can ever open the drop again.
 */
export function dropTerminal(item: DropItem, now = new Date()): boolean {
  return (
    item.state !== "pending" || Date.parse(item.expiresAt) <= now.getTime()
  );
}

export function activeItems(items: VaultItem[]): VaultItem[] {
  return items.filter((item) => item.deletedAt === null && !isRetired(item));
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

export function createItem(kind: "login", name?: string): LoginItem;
export function createItem(kind: "passkey", name?: string): PasskeyItem;
export function createItem(kind: "card", name?: string): CardItem;
export function createItem(kind: "secret", name?: string): SecretItem;
export function createItem(kind: "note", name?: string): NoteItem;
export function createItem(kind: "certificate", name?: string): CertificateItem;
export function createItem(kind: "drop", name?: string): DropItem;
export function createItem(kind: ItemKind, name?: string): VaultItem;
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
    case "certificate":
      return {
        ...b,
        kind: "certificate",
        commonName: name || "localhost",
        dnsNames: "localhost",
        ipAddrs: "127.0.0.1",
        ttlHours: "24",
        certificatePem: "",
        privateKeyPem: "",
        caPem: "",
        serial: "",
        notAfter: "",
      };
    case "drop":
      // A stub for switch exhaustiveness: the +new Drop ceremony builds the
      // real record from the claim session it created — claimId, bearerToken,
      // and expiresAt are never blank in a saved drop.
      return {
        ...b,
        kind: "drop",
        state: "pending",
        claimId: "",
        bearerToken: "",
        expiresAt: b.createdAt,
      };
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
    case "certificate":
      return item.notAfter
        ? `${item.commonName} · until ${item.notAfter.slice(0, 10)}`
        : item.commonName || "Dev certificate";
    case "drop":
      return item.state === "pending"
        ? `Opens once · until ${item.expiresAt.slice(0, 10)}`
        : item.state === "consumed"
          ? "Opened — purges on next read"
          : "Expired — purges on next read";
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
  if (item.kind === "certificate") {
    haystack.push(item.commonName, item.dnsNames, item.serial);
  }
  if (item.kind === "drop") haystack.push(item.state);
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
