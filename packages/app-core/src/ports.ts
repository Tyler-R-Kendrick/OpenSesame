/**
 * The platform ports (ADR 0133 §2): everything the core needs that differs
 * between a browser tab, a CLI process and an Android isolate. The runtime
 * contract — `crypto`, `fetch`, `URL`, `TextEncoder`, timers and the other
 * globals every host provides — is not here; this is the rest.
 *
 * A port is optional on the host. Code reads it through the accessors below
 * at call time, never at import. The `require…` accessors throw when the host
 * has no such port — the same failure touching a missing browser global used
 * to be — and the plain ones answer `undefined` where the code already had a
 * fallback.
 *
 * Port types name DOM interfaces where the shape is the browser's own
 * (`Location`, `CredentialsContainer`, …). Those are types only: they are
 * erased at build time and load nothing on a host without a DOM.
 */
import { host } from "./host.js";
import { sealedWebStorage } from "./lib/at-rest/web-storage.js";
import { storageWritesHalted } from "./lib/storage-halt.js";
import { type WebStorageArea, ownsDatabase } from "./lib/storage-ownership.js";
import type { PhysicalAuthenticationPort } from "./lib/vault/physical-authentication-port.js";
import type { PhysicalVaultPublicationPort } from "./lib/vault/physical-vault-publication-port.js";

/** Web Storage, as `localStorage` and `sessionStorage` expose it. */
export type WebStorage = {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type StoragePorts = {
  /** Persists across sessions (`localStorage` in a browser). */
  readonly local?: WebStorage;
  /** Lives as long as the tab (`sessionStorage` in a browser). */
  readonly session?: WebStorage;
};

export type PageLocation = Pick<
  Location,
  | "origin"
  | "href"
  | "protocol"
  | "host"
  | "hostname"
  | "pathname"
  | "search"
  | "hash"
  | "assign"
  | "replace"
  | "reload"
>;

/**
 * The document the core runs in: its address, its window's messages and
 * lifecycle, its popups and opener, and the two things the core asks the DOM
 * to do (start a download, post a form). Absent where there is no page.
 */
export type PagePort = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "open" | "close"
> & {
  readonly location: PageLocation;
  readonly opener: WindowProxy | null;
  readonly isSecureContext: boolean;
  readonly visibilityState: DocumentVisibilityState;
  /** Rewrite the address without navigating (`history.replaceState`). */
  replaceUrl(url: string): void;
  onVisibilityChange(listener: () => void): () => void;
  /** Start a download of `href` (an object URL the caller owns) as `fileName`. */
  startDownload(href: string, fileName: string): void;
  /** Navigate by posting a form of hidden fields (UTF-8) to `action`. */
  submitForm(
    action: string,
    fields: Readonly<Record<string, string>>,
    target: string,
  ): void;
};

/** WebAuthn: the credentials container and the credential interface. */
export type AuthenticatorPort = {
  readonly credentials?: Pick<CredentialsContainer, "create" | "get">;
  readonly publicKeyCredential?: typeof PublicKeyCredential;
};

/**
 * Chrome's Local Network Access permission for this page: whether a request
 * to a private or loopback address (a tailnet drive, a local daemon) may go
 * out, will wait on a prompt, or is refused. `unsupported` where the browser
 * has no such permission and requests go out as before.
 */
export type LocalNetworkPermission =
  | "granted"
  | "prompt"
  | "denied"
  | "unsupported";

/** What the device is doing: connectivity, activation, identification. */
export type EnvironmentPort = {
  /** The Local Network Access permission; absent where the host has none. */
  localNetworkPermission?(): Promise<LocalNetworkPermission>;
  readonly online: boolean;
  onOnlineChange(listener: (online: boolean) => void): () => void;
  readonly userAgent: string;
  /** A user gesture is in effect (`navigator.userActivation.isActive`). */
  readonly userActivated: boolean;
  /** Execution contexts this platform can start. */
  readonly workers: Readonly<{
    dedicated: boolean;
    shared: boolean;
    service: boolean;
  }>;
};

/** Web Locks, as `navigator.locks` offers them. */
export type LockManagerLike = Pick<LockManager, "request">;

export type BroadcastLike = Pick<
  BroadcastChannel,
  "postMessage" | "close" | "addEventListener" | "removeEventListener"
> & { onmessage: BroadcastChannel["onmessage"] };

/**
 * Where the host keeps the device's at-rest data key (ADR 0149): 32 bytes
 * every stored value is sealed under. A host without one stores nothing past
 * the process rather than store it in the clear (`lib/at-rest/key.ts`).
 */
export type AtRestKeyPort = {
  /** The key, when the host can produce it without waiting (a file, a test). */
  loadSync?(): Uint8Array;
  /** The key, created on first use. Rejects when the host cannot keep one. */
  load(): Promise<Uint8Array>;
};

/**
 * The dedicated-worker constructor. Callers keep the literal
 * `new Worker(new URL("./x.worker.ts", import.meta.url), …)` with `Worker`
 * bound to this, so the bundler still finds and emits the worker entry in
 * the module that owns it — never in the host, which boot loads.
 */
export type WorkerConstructor = new (
  url: URL | string,
  options?: WorkerOptions,
) => Worker;

/** The two `IDBKeyRange` constructors the core uses. */
export type KeyRangeFactory = {
  only(value: IDBValidKey): IDBKeyRange;
  bound(lower: IDBValidKey, upper: IDBValidKey): IDBKeyRange;
};

export type Ports = {
  readonly physicalVaultPublication?: PhysicalVaultPublicationPort;
  readonly physicalVaultAuthentication?: PhysicalAuthenticationPort;
  readonly storage?: StoragePorts;
  readonly atRestKeys?: AtRestKeyPort;
  readonly page?: PagePort;
  readonly authenticator?: AuthenticatorPort;
  readonly environment?: EnvironmentPort;
  readonly locks?: LockManagerLike;
  /** A same-origin broadcast channel, where contexts can share one. */
  readonly broadcast?: (name: string) => BroadcastLike;
  readonly worker?: WorkerConstructor;
  readonly serviceWorker?: ServiceWorkerContainer;
  /** The origin-private file system root (`navigator.storage.getDirectory`). */
  readonly originFiles?: () => Promise<FileSystemDirectoryHandle>;
  readonly indexedDB?: IDBFactory;
  /** Builds the key ranges an IndexedDB index is queried with. */
  readonly keyRange?: KeyRangeFactory;
  /**
   * Resolves a peer hostname before a duress peer request. A host that
   * cannot resolve leaves this unset, and a name is then refused.
   */
  readonly peerDns?: {
    lookup(hostname: string): Promise<readonly string[]>;
  };
  /** The Cache API (`caches`): where the service worker keeps the offline shell. */
  readonly cacheStorage?: CacheStorage;
  /**
   * Told of every Web Storage write the core makes through these ports. The
   * test hosts record them (`test-host-storage-writes.ts`); a shell has none.
   */
  readonly recordStorageWrite?: (area: WebStorageArea, key: string) => void;
};

function missing(port: string): Error {
  return new Error(`app-core: this host has no ${port}`);
}

/**
 * A store as the core writes it. Every value is sealed under the device's
 * at-rest key (`lib/at-rest/web-storage.ts`, ADR 0149). Every write is
 * reported to the host's recorder, where it has one — the test hosts fail a test that writes a key
 * the app does not own (`lib/storage-ownership.ts`), so no key can silently
 * outlive "Reset this browser" — and once this browser is being reset
 * (`lib/storage-halt.ts`) a write does nothing.
 */
function owned(
  store: WebStorage | undefined,
  area: WebStorageArea,
): WebStorage | undefined {
  if (!store) return undefined;
  const sealed = sealedWebStorage(store, area);
  return {
    get length() {
      return sealed.length;
    },
    key: (index) => sealed.key(index),
    getItem: (key) => sealed.getItem(key),
    setItem(key, value) {
      host().recordStorageWrite?.(area, key);
      if (storageWritesHalted()) return;
      sealed.setItem(key, value);
    },
    removeItem: (key) => sealed.removeItem(key),
  };
}

export function maybeLocalStore(): WebStorage | undefined {
  return owned(host().storage?.local, "local");
}

export function localStore(): WebStorage {
  const store = maybeLocalStore();
  if (!store) throw missing("local storage");
  return store;
}

export function maybeSessionStore(): WebStorage | undefined {
  return owned(host().storage?.session, "session");
}

export function sessionStore(): WebStorage {
  const store = maybeSessionStore();
  if (!store) throw missing("session storage");
  return store;
}

export function maybePage(): PagePort | undefined {
  return host().page;
}

export function page(): PagePort {
  const current = maybePage();
  if (!current) throw missing("page");
  return current;
}

/** The page's origin; throws where there is no page. */
export function pageOrigin(): string {
  return page().location.origin;
}

export function credentials(): AuthenticatorPort["credentials"] {
  return host().authenticator?.credentials;
}

export function requireCredentials(): Pick<
  CredentialsContainer,
  "create" | "get"
> {
  const container = credentials();
  if (!container) throw missing("WebAuthn credentials container");
  return container;
}

export function publicKeyCredentialApi():
  | typeof PublicKeyCredential
  | undefined {
  return host().authenticator?.publicKeyCredential;
}

/** `value instanceof PublicKeyCredential`, on a host that has the interface. */
export function isPublicKeyCredential(
  value: Credential | null | undefined,
): value is PublicKeyCredential {
  const api = publicKeyCredentialApi();
  return api !== undefined && value instanceof api;
}

export function maybeEnvironment(): EnvironmentPort | undefined {
  return host().environment;
}

/** The Local Network Access permission; `unsupported` where the host has none. */
export async function localNetworkPermission(): Promise<LocalNetworkPermission> {
  return (
    (await maybeEnvironment()?.localNetworkPermission?.()) ?? "unsupported"
  );
}

/** Online unless the host says otherwise: a host with no network signal. */
export function isOnline(): boolean {
  return maybeEnvironment()?.online ?? true;
}

/** The platform's self-description; empty where the host gives none. */
export function userAgent(): string {
  return maybeEnvironment()?.userAgent ?? "";
}

export function lockManager(): LockManagerLike | undefined {
  return host().locks;
}

export function openBroadcast(name: string): BroadcastLike | null {
  return host().broadcast?.(name) ?? null;
}

export function maybeWorkerConstructor(): WorkerConstructor | undefined {
  return host().worker;
}

export function workerConstructor(): WorkerConstructor {
  const create = maybeWorkerConstructor();
  if (!create) throw missing("worker support");
  return create;
}

export function serviceWorkerContainer(): ServiceWorkerContainer | undefined {
  return host().serviceWorker;
}

export function originFiles(): Ports["originFiles"] {
  return host().originFiles;
}

/**
 * Open one of the app's own databases. A name `lib/storage-ownership.ts` does
 * not list is refused, so no database escapes "Reset this browser".
 */
export function openOwnedDatabase(
  name: string,
  version: number,
): IDBOpenDBRequest {
  if (!ownsDatabase(name)) {
    throw new Error(
      `app-core: IndexedDB "${name}" is not one this app owns (lib/storage-ownership.ts)`,
    );
  }
  const factory = host().indexedDB;
  if (!factory) throw missing("IndexedDB");
  return factory.open(name, version);
}

export function maybeIndexedDatabases(): IDBFactory | undefined {
  return host().indexedDB;
}

/** The host's `IDBKeyRange`; throws where the host keeps none. */
export function keyRanges(): KeyRangeFactory {
  const factory = host().keyRange;
  if (!factory) throw missing("IDBKeyRange");
  return factory;
}

export function maybeCacheStorage(): CacheStorage | undefined {
  return host().cacheStorage;
}
