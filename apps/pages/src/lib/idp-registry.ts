/**
 * The local IdP registry — the binding this device brokers (ADR 0060).
 *
 * Tailscale locks a tailnet to an IdP at creation; OpenSesame records, per
 * device, every identity provider this browser brokers: BYO upstreams it
 * registered itself (ADR 0055) and first-class catalog providers chosen in the
 * Identity ceremony. The record is a mirror, not the source of truth — the
 * server-side registration list is operator-token-only, so a browser can only
 * ever see what it registered itself, and the UI says exactly that.
 *
 * The registry also carries the ceremony gate: `ceremonyDismissed` is the
 * operator's explicit "set up later", which lifts the gate without a binding.
 */

import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

const STORAGE_KEY = "opensesame.idp-registry.v1";

export type IdpKind = "first-class" | "byo";

export type IdpRecord = {
  id: string;
  issuer: string;
  label: string;
  kind: IdpKind;
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

function readRawDefault(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be denied outright (private mode); the registry reads empty.
    return null;
  }
}

function writeRawDefault(raw: string): void {
  // A mirror of IdP bindings — no secret material, so durable local storage is
  // the right home (the binding is meant to survive restarts).
  // ast-grep-ignore: ts-localstorage-set
  localStorage.setItem(STORAGE_KEY, raw);
}

function clearRawDefault(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

export const idpRegistrySeams = {
  read: readRawDefault,
  write: writeRawDefault,
  clear: clearRawDefault,
};

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
