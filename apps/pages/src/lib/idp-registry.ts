/**
 * The local IdP registry — the binding this device brokers (ADR 0060).
 *
 * Tailscale locks a tailnet to an IdP at creation; OpenSesame records, per
 * device, every identity provider this browser brokers: BYO upstreams it
 * registered itself (ADR 0055) and first-class catalog providers chosen in
 * the Identity ceremony. The record is a mirror, not the source of truth — the
 * server-side registration list is operator-token-only, so a browser can only
 * ever see what it registered itself, and the UI says exactly that.
 *
 * The registry also carries the ceremony gate: `ceremonyDismissed` is the
 * operator's explicit "set up later", which lifts the gate without a binding.
 *
 * Storage (ADR 0063): the registry lives sealed in the active tomb at
 * `tomb/<name>/config/idp-registry` — it left localStorage with the encrypted
 * VFS. Hydrated into memory on unlock (`hydrateIdpRegistryFromVfs`) and
 * discarded on lock (`discardIdpRegistry`), so while the vault is locked the
 * registry is unreadable. Every consumer (the Identity screen) is already
 * post-unlock; the sign-in hub never consults the registry — the first-class
 * catalog is server-fetched and the BYO hint comes from the sheet flow.
 */

import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { VfsError, readFile, writeFile } from "./vfs.js";

/** Legacy localStorage key — migrated into the tomb on unlock, then deleted. */
const LEGACY_STORAGE_KEY = "opensesame.idp-registry.v1";

/** Sealed VFS path (within a tomb) holding the registry JSON. */
export const IDP_REGISTRY_CONFIG_PATH = "config/idp-registry";

export type IdpKind = "first-class" | "byo";

/** The enterprise SSO preset a BYO record was registered through, if any. */
export type IdpProviderType = "workos" | "okta" | "auth0" | "better-auth";

const IDP_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "workos",
  "okta",
  "auth0",
  "better-auth",
]);

function isIdpProviderType(value: BoundaryValue): value is IdpProviderType {
  return isString(value) && IDP_PROVIDER_TYPES.has(value);
}

export type IdpRecord = {
  id: string;
  issuer: string;
  label: string;
  kind: IdpKind;
  /** Preset the record was registered through; legacy BYO rows have none. */
  providerType?: IdpProviderType;
  /** BYO only: the client the deployment registered (or was handed). */
  clientId?: string;
  clientAuth?: string;
  /** What the visitor registers at their own IdP when DCR was unavailable. */
  redirectUri?: string;
  registeredAt: string;
};

type StoredRegistry = {
  providers: IdpRecord[];
  ceremonyDismissed: boolean;
};

const EMPTY_REGISTRY: StoredRegistry = {
  providers: [],
  ceremonyDismissed: false,
};

function isIdpRecord(value: BoundaryValue): value is IdpRecord {
  if (!isJsonObject(value)) return false;
  return (
    isString(value.id) &&
    value.id.length > 0 &&
    isString(value.issuer) &&
    isString(value.label) &&
    (value.kind === "first-class" || value.kind === "byo") &&
    (value.providerType === undefined ||
      isIdpProviderType(value.providerType)) &&
    (value.clientId === undefined || isString(value.clientId)) &&
    (value.clientAuth === undefined || isString(value.clientAuth)) &&
    (value.redirectUri === undefined || isString(value.redirectUri)) &&
    isString(value.registeredAt)
  );
}

/**
 * Malformed JSON — a hand-edited store, an older build's shape — reads as the
 * empty registry rather than breaking the section: the ceremony simply shows
 * again, which is the safe first-run posture.
 */
function parseRegistry(raw: string | null): StoredRegistry {
  if (!raw) return EMPTY_REGISTRY;
  try {
    const body: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(body)) return EMPTY_REGISTRY;
    const providers = Array.isArray(body.providers)
      ? body.providers.filter(isIdpRecord)
      : [];
    return {
      providers,
      ceremonyDismissed: isBoolean(body.ceremonyDismissed)
        ? body.ceremonyDismissed
        : false,
    };
  } catch {
    return EMPTY_REGISTRY;
  }
}

function saveRegistry(registry: StoredRegistry): void {
  idpRegistrySeams.write(
    JSON.stringify({
      version: 1,
      providers: registry.providers,
      ceremonyDismissed: registry.ceremonyDismissed,
    }),
  );
}

/* ------------------------------------------------------------- transport */

/**
 * The decrypted registry, cached in memory for the unlocked session. The
 * exported API stays synchronous (callers don't change); the VFS read that
 * fills the cache runs at unlock, and every write-through persists sealed.
 */
let activeTomb: string | null = null;
let cachedRaw: string | null = null;
let hydrated = false;

function readCachedDefault(): string | null {
  // Locked (never hydrated): the registry is unreadable — empty posture.
  return hydrated ? cachedRaw : null;
}

function writeCachedDefault(raw: string): void {
  cachedRaw = raw;
  hydrated = true;
  const tomb = activeTomb;
  if (!tomb) return;
  void writeFile(
    tomb,
    IDP_REGISTRY_CONFIG_PATH,
    new TextEncoder().encode(raw),
  ).catch(() => {
    /* a mirror, never the source of truth — the next unlock re-reads */
  });
}

function clearCachedDefault(): void {
  cachedRaw = null;
  hydrated = true;
  const tomb = activeTomb;
  if (!tomb) return;
  void writeFile(
    tomb,
    IDP_REGISTRY_CONFIG_PATH,
    new TextEncoder().encode(JSON.stringify(EMPTY_REGISTRY)),
  ).catch(() => {
    /* a mirror, never the source of truth — the next unlock re-reads */
  });
}

export const idpRegistrySeams = {
  read: readCachedDefault,
  write: writeCachedDefault,
  clear: clearCachedDefault,
};

/**
 * Fill the in-memory cache from the tomb's sealed config. Runs on unlock,
 * after `migrateTombConfigOnUnlock` has moved any legacy localStorage copy.
 * An unreadable file reads as empty — the mirror posture: the ceremony shows
 * again and nothing is lost.
 */
export async function hydrateIdpRegistryFromVfs(tomb: string): Promise<void> {
  activeTomb = tomb;
  try {
    const bytes = await readFile(tomb, IDP_REGISTRY_CONFIG_PATH);
    cachedRaw = new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof VfsError && error.code === "locked") throw error;
    cachedRaw = null;
  }
  hydrated = true;
}

/** Lock: forget the decrypted registry and which tomb it belonged to. */
export function discardIdpRegistry(): void {
  activeTomb = null;
  cachedRaw = null;
  hydrated = false;
}

/** Legacy localStorage copy, for the unlock-time migration only. */
export function readLegacyIdpRegistry(): string | null {
  try {
    return localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage can be denied outright (private mode); nothing to migrate.
    return null;
  }
}

export function clearLegacyIdpRegistry(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

/* ----------------------------------------------------------------- API */

/** Every IdP this device brokers, oldest registration first. */
export function listIdpRegistrations(): IdpRecord[] {
  return parseRegistry(idpRegistrySeams.read()).providers;
}

/** The operator's explicit "set up later" — lifts the gate with no binding. */
export function ceremonyDismissed(): boolean {
  return parseRegistry(idpRegistrySeams.read()).ceremonyDismissed;
}

/** The gate condition: no binding recorded and no explicit deferral. */
export function idpCeremonyNeeded(): boolean {
  const registry = parseRegistry(idpRegistrySeams.read());
  return registry.providers.length === 0 && !registry.ceremonyDismissed;
}

/**
 * Record a binding. Upserts by id — re-registering the same provider refreshes
 * its record rather than listing it twice. Registering also lifts the ceremony
 * gate permanently: removing the last mirror later shows the Providers banner,
 * never the gate again.
 */
export function registerIdp(record: IdpRecord): IdpRecord[] {
  const registry = parseRegistry(idpRegistrySeams.read());
  const providers = [
    ...registry.providers.filter((existing) => existing.id !== record.id),
    record,
  ];
  saveRegistry({ ...registry, providers, ceremonyDismissed: true });
  return providers;
}

/**
 * Drop the local mirror of a binding. The server-side registration is
 * disable-only and operator-gated — removal here never claims to delete it.
 */
export function removeIdpRegistration(id: string): IdpRecord[] {
  const registry = parseRegistry(idpRegistrySeams.read());
  const providers = registry.providers.filter((existing) => existing.id !== id);
  saveRegistry({ ...registry, providers });
  return providers;
}

/** Record the explicit deferral that lifts the ceremony gate. */
export function dismissIdpCeremony(): void {
  const registry = parseRegistry(idpRegistrySeams.read());
  saveRegistry({ ...registry, ceremonyDismissed: true });
}
