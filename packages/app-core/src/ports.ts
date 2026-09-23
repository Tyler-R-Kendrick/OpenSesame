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

/** What the device is doing: connectivity, activation, identification. */
export type EnvironmentPort = {
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
 * The dedicated-worker constructor. Callers keep the literal
 * `new Worker(new URL("./x.worker.ts", import.meta.url), …)` with `Worker`
 * bound to this, so the bundler still finds and emits the worker entry in
 * the module that owns it — never in the host, which boot loads.
 */
export type WorkerConstructor = new (
  url: URL | string,
  options?: WorkerOptions,
) => Worker;

export type Ports = {
  readonly storage?: StoragePorts;
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
};

function missing(port: string): Error {
  return new Error(`app-core: this host has no ${port}`);
}

export function maybeLocalStore(): WebStorage | undefined {
  return host().storage?.local;
}

export function localStore(): WebStorage {
  const store = maybeLocalStore();
  if (!store) throw missing("local storage");
  return store;
}

export function maybeSessionStore(): WebStorage | undefined {
  return host().storage?.session;
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

export function indexedDatabases(): IDBFactory {
  const factory = host().indexedDB;
  if (!factory) throw missing("IndexedDB");
  return factory;
}
