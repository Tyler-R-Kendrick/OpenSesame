/**
 * The local IdP registry — the binding this device brokers (ADR 0060 + 0118).
 *
 * OpenSesame itself is always the first identity provider: the device-native
 * Identity host (ADR 0118) and browser-local IAM. Additional upstreams — BYO
 * (ADR 0055) and first-class catalog providers from the Identity ceremony —
 * are optional extras recorded here as a local mirror. An empty additional
 * list is not an error and must never read as "no identity provider".
 *
 * The registry also carries `ceremonyDismissed` for the optional "add another
 * IdP" ceremony deferral. Storage (ADR 0063): sealed at
 * `tomb/<name>/config/idp-registry`, hydrated on unlock, discarded on lock.
 */

import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { pagesIdentityPublicBase } from "./device-identity.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { VfsError, readFile, writeFile } from "./vfs.js";

/** Legacy localStorage key — migrated into the tomb on unlock, then deleted. */
const LEGACY_STORAGE_KEY = "opensesame.idp-registry.v1";

/** Sealed VFS path (within a tomb) holding the registry JSON. */
export const IDP_REGISTRY_CONFIG_PATH = "config/idp-registry";

/** Synthetic id for the always-present device-native IdP — never persisted. */
export const DEVICE_IDP_ID = "opensesame-device";

/** Dogfood label — parallel to `OpenSesame (this vault)` for the authenticator. */
export const DEVICE_IDP_LABEL = "OpenSesame (this device)";

/** Stable registration time for the synthetic device row (not operator-set). */
const DEVICE_IDP_REGISTERED_AT = "1970-01-01T00:00:00.000Z";

export type IdpKind = "first-class" | "byo" | "device";

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
 * empty *additional* registry. The device IdP still vouches (list API).
 */
function parseRegistry(raw: string | null): StoredRegistry {
  if (!raw) return EMPTY_REGISTRY;
  try {
    const body: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(body)) return EMPTY_REGISTRY;
    const providers = Array.isArray(body.providers)
      ? body.providers.filter(
          (row): row is IdpRecord =>
            isIdpRecord(row) && row.id !== DEVICE_IDP_ID,
        )
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

/** Always-present device-native IdP — Pages is the Identity plane for itself. */
export function deviceIdpRecord(issuer = pagesIdentityPublicBase()): IdpRecord {
  return {
    id: DEVICE_IDP_ID,
    issuer,
    label: DEVICE_IDP_LABEL,
    kind: "device",
    registeredAt: DEVICE_IDP_REGISTERED_AT,
  };
}

function withDeviceIdp(additional: IdpRecord[]): IdpRecord[] {
  return [deviceIdpRecord(), ...additional];
}

function saveRegistry(registry: StoredRegistry): void {
  idpRegistrySeams.write(
    JSON.stringify({
      version: 1,
      providers: registry.providers,
      ceremonyDismissed: registry.ceremonyDismissed,
    }),
  );
  notifyLocalIamChange();
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

/**
 * Every IdP this device brokers: the device-native OpenSesame IdP first, then
 * any additional upstreams (oldest registration first). Never empty.
 */
export function listIdpRegistrations(): IdpRecord[] {
  return withDeviceIdp(parseRegistry(idpRegistrySeams.read()).providers);
}

/** Additional upstreams only — excludes the built-in device IdP. */
export function listAdditionalIdpRegistrations(): IdpRecord[] {
  return parseRegistry(idpRegistrySeams.read()).providers;
}

/** The operator's explicit "set up later" — defers adding another upstream. */
export function ceremonyDismissed(): boolean {
  return parseRegistry(idpRegistrySeams.read()).ceremonyDismissed;
}

/**
 * Whether the optional "add another IdP" ceremony should interrupt first
 * navigation. Always false: the device IdP already vouches (ADR 0118).
 */
export function idpCeremonyNeeded(): boolean {
  return false;
}

/**
 * Record an additional upstream. Upserts by id. Cannot replace the device IdP.
 * Registering lifts the optional ceremony deferral.
 */
export function registerIdp(record: IdpRecord): IdpRecord[] {
  if (record.id === DEVICE_IDP_ID || record.kind === "device") {
    return listIdpRegistrations();
  }
  const registry = parseRegistry(idpRegistrySeams.read());
  const providers = [
    ...registry.providers.filter((existing) => existing.id !== record.id),
    record,
  ];
  saveRegistry({ ...registry, providers, ceremonyDismissed: true });
  return withDeviceIdp(providers);
}

/**
 * Drop the local mirror of an additional upstream. The device IdP cannot be
 * removed. Server-side registration is disable-only and operator-gated.
 */
export function removeIdpRegistration(id: string): IdpRecord[] {
  if (id === DEVICE_IDP_ID) return listIdpRegistrations();
  const registry = parseRegistry(idpRegistrySeams.read());
  const providers = registry.providers.filter((existing) => existing.id !== id);
  saveRegistry({ ...registry, providers });
  return withDeviceIdp(providers);
}

/** Record the explicit deferral that lifts the ceremony gate. */
export function dismissIdpCeremony(): void {
  const registry = parseRegistry(idpRegistrySeams.read());
  saveRegistry({ ...registry, ceremonyDismissed: true });
}
