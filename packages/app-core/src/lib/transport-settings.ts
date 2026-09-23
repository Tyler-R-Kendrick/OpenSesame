/**
 * The transport block of the persisted settings: what a person *wants* for a
 * named target, spelled entirely in references.
 *
 * A tenant-level form may select an already registered identity or trust
 * profile by name. It may never name a file, a socket, a URL, a PEM or a key
 * — native source selection is a deployment-plane operator capability, and
 * the value the browser stores is only ever a name (directive UI-CONFIG;
 * cross-swarm rule "native source access is not a tenant capability").
 * Anything that looks like a locator is refused whole, so a half-admitted
 * entry cannot become a transport setting with a secret behind it.
 *
 * Defaults are empty on every origin: no target, no policy, no endpoint
 * (AGENTS.md §5 — no default points at a local host). The block lives under
 * its own key beside `settings.v1`, so the endpoint settings file never
 * carries it and a locator can never arrive through that road either.
 */
import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvGet, kvSet } from "./kv.js";
import {
  type IdentitySourceRef,
  REF_NAME,
  TRANSPORT_POLICIES,
  type TransportPolicy,
  type TrustProfileRef,
} from "./transport-model.js";

export const EXECUTION_TARGETS = ["browser", "host", "worker"] as const;
export type TransportExecutionTarget = (typeof EXECUTION_TARGETS)[number];

export type BrowserManagedProfile = {
  kind: "browser_managed";
  /** What the person calls the certificate their browser holds. */
  displayName: string;
};

export type TransportTargetSettings = {
  desiredPolicy: TransportPolicy;
  identityRef?: IdentitySourceRef;
  trustRef?: TrustProfileRef;
  executionTarget: TransportExecutionTarget;
  browserProfile?: BrowserManagedProfile;
};

/** Keyed by target name (a reference name, never an address). */
export type TransportSettings = Record<string, TransportTargetSettings>;

/** The target name a fresh form starts on. A name, not a place. */
export const DEFAULT_TRANSPORT_TARGET = "remote";

export type LocatorKind = "path" | "socket" | "url" | "pem" | "key";

const LOCATOR_RULES: ReadonlyArray<[LocatorKind, RegExp]> = [
  ["pem", /-----BEGIN/i],
  ["key", /(private|secret)[ _-]?key|^(ssh-|age1|AKIA|sk[-_]|ghp_|xox)/i],
  ["socket", /\.sock$|^unix:/i],
  ["url", /^[a-z][a-z0-9+.-]*:\/\/|^(https?|spiffe|file|tcp|nats|wss?):/i],
  ["path", /^(\/|\.\.?\/|~\/|[a-z]:\\)|[\\/]/i],
];

/**
 * Why a value cannot be a reference, or null when nothing about it looks
 * like a locator. Checked before the name pattern so the refusal is named:
 * "that is a path" tells a person more than "not a name".
 */
export function locatorKind(value: string): LocatorKind | null {
  for (const [kind, rule] of LOCATOR_RULES) {
    if (rule.test(value)) return kind;
  }
  if (value.length > 64 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return "key";
  return null;
}

/** A reference name: the spelling in CONTRACT §3, and nothing locator-shaped. */
export function isRefName(value: string): boolean {
  return REF_NAME.test(value) && locatorKind(value) === null;
}

export function defaultTransportTarget(): TransportTargetSettings {
  return { desiredPolicy: "existing_local", executionTarget: "browser" };
}

function readRef(value: JsonValue | undefined): { name: string } | null {
  if (value === undefined) return null;
  if (!isJsonObject(value) || !isString(value.name)) return null;
  return isRefName(value.name) ? { name: value.name } : null;
}

function readBrowserProfile(
  value: JsonValue | undefined,
): BrowserManagedProfile | null {
  if (!isJsonObject(value) || value.kind !== "browser_managed") return null;
  const displayName = value.displayName;
  if (!isString(displayName)) return null;
  const trimmed = displayName.trim();
  if (!trimmed || trimmed.length > 64 || locatorKind(trimmed)) return null;
  return { kind: "browser_managed", displayName: trimmed };
}

/**
 * One target's block, read whole. Null when any field is malformed or
 * locator-shaped — the entry is dropped rather than admitted in part.
 */
export function readTransportTarget(
  value: JsonValue | undefined,
): TransportTargetSettings | null {
  if (!isJsonObject(value)) return null;
  const policy = TRANSPORT_POLICIES.find((p) => p === value.desiredPolicy);
  const execution = EXECUTION_TARGETS.find((t) => t === value.executionTarget);
  if (!policy || !execution) return null;
  const target: TransportTargetSettings = {
    desiredPolicy: policy,
    executionTarget: execution,
  };
  for (const key of ["identityRef", "trustRef"] as const) {
    if (value[key] === undefined) continue;
    const ref = readRef(value[key]);
    if (!ref) return null;
    target[key] = ref;
  }
  if (value.browserProfile !== undefined) {
    const profile = readBrowserProfile(value.browserProfile);
    if (!profile) return null;
    target.browserProfile = profile;
  }
  return target;
}

/** The persisted block, read back; unreadable entries do not survive. */
export function readTransportSettings(
  value: JsonValue | undefined,
): TransportSettings {
  const out: TransportSettings = {};
  if (!isJsonObject(value)) return out;
  for (const [name, entry] of Object.entries(value)) {
    if (!isRefName(name)) continue;
    const target = readTransportTarget(entry);
    if (target) out[name] = target;
  }
  return out;
}

/** What is written is exactly what would be read back. */
export function normalizeTransportSettings(
  value: TransportSettings | undefined,
): TransportSettings {
  if (!value) return {};
  const asJson: JsonObject = JSON.parse(JSON.stringify(value));
  return readTransportSettings(asJson);
}

/** A target's settings, or the empty defaults when nobody set any. */
export function transportTargetSettings(
  settings: TransportSettings | undefined,
  target: string,
): TransportTargetSettings {
  return settings?.[target] ?? defaultTransportTarget();
}

/** Targets a person has configured, in the order they were added. */
export function transportTargetNames(
  settings: TransportSettings | undefined,
): string[] {
  return Object.keys(settings ?? {});
}

/** The block with one target replaced (pure). A default block is removed. */
export function withTransportTarget(
  settings: TransportSettings | undefined,
  target: string,
  next: TransportTargetSettings,
): TransportSettings {
  const out = { ...(settings ?? {}) };
  if (!isRefName(target)) return out;
  const defaults = defaultTransportTarget();
  const bare =
    next.desiredPolicy === defaults.desiredPolicy &&
    next.executionTarget === defaults.executionTarget &&
    !next.identityRef &&
    !next.trustRef &&
    !next.browserProfile;
  if (bare) delete out[target];
  else out[target] = next;
  return normalizeTransportSettings(out);
}

const PERSIST_KEY = "settings.transport.v1";
const listeners = new Set<() => void>();
let epoch = 0;

/** Bumped on every write so a panel can re-render for a changed block. */
export function transportSettingsEpoch(): number {
  return epoch;
}

export function subscribeTransportSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The persisted block, or empty: never a default that names a place. */
export function loadTransportSettings(): TransportSettings {
  try {
    const raw = kvGet(PERSIST_KEY);
    if (!raw) return {};
    const parsed: BoundaryValue = JSON.parse(raw);
    return readTransportSettings(isJsonObject(parsed) ? parsed : undefined);
  } catch {
    return {};
  }
}

export function saveTransportSettings(next: TransportSettings): void {
  kvSet(PERSIST_KEY, JSON.stringify(normalizeTransportSettings(next)));
  epoch += 1;
  for (const listener of listeners) listener();
}
