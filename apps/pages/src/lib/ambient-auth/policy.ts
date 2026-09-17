/**
 * Versioned automatic-sign-in policy. Resolution is pure and performs no
 * network I/O. A remembered last-method is never treated as consent.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { OperatorIdp } from "../settings.js";
import {
  type ProviderConnection,
  parseProviderConnectionKey,
  protocolForIssuer,
  providerConnectionKey,
  supportsCapability,
} from "./provider.js";
import type {
  AmbientAuthMode,
  AmbientPolicyProvenance,
  AmbientTransport,
  ProviderConnectionKey,
} from "./types.js";

export const AMBIENT_POLICY_SCHEMA = 1 as const;

const MIN_COOLDOWN_MS = 15_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const MIN_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 12_000;

export type AmbientAuthPolicy = {
  schemaVersion: typeof AMBIENT_POLICY_SCHEMA;
  mode: AmbientAuthMode;
  selectedProviderKey?: ProviderConnectionKey;
  tenantAuthority?: string;
  allowedTransport: AmbientTransport;
  allowVisibleTopLevel: boolean;
  cooldownMs: number;
  timeoutMs: number;
  permitJitProvisioning: boolean;
  policyRevision: string;
  provenance: AmbientPolicyProvenance;
};

export type AmbientPolicyInputs = {
  runtime?: unknown;
  userPreference?: unknown;
  lastSignInMethod?: string | null;
  operatorProviders?: readonly OperatorIdp[];
  builtinIssuer?: { id: string; issuer: string; clientId: string };
};

export type AmbientPolicyDecision = {
  policy: AmbientAuthPolicy;
  connection: ProviderConnection | null;
  eligible: boolean;
  reason:
    | "disabled"
    | "opt-in-missing"
    | "provider-removed"
    | "conflict"
    | "unsupported"
    | "eligible";
};

const DISABLED: AmbientAuthPolicy = Object.freeze({
  schemaVersion: 1,
  mode: "disabled",
  allowedTransport: "interactive-continue",
  allowVisibleTopLevel: false,
  cooldownMs: DEFAULT_COOLDOWN_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  permitJitProvisioning: false,
  policyRevision: "disabled",
  provenance: "default",
});

export function defaultAmbientAuthPolicy(): AmbientAuthPolicy {
  return DISABLED;
}

export function resolveAmbientAuthPolicy(
  inputs: AmbientPolicyInputs = {},
): AmbientPolicyDecision {
  const runtime = readPolicyBlob(inputs.runtime, "deployment-runtime");
  if (runtime && runtime.mode === "deployment-selected") {
    return decide(runtime, inputs, "deployment-runtime");
  }
  const user = readPolicyBlob(inputs.userPreference, "user-opt-in");
  if (user && user.mode === "returning-opt-in") {
    return decide(user, inputs, "user-opt-in");
  }
  return {
    policy: DISABLED,
    connection: null,
    eligible: false,
    reason: inputs.lastSignInMethod ? "opt-in-missing" : "disabled",
  };
}

function decide(
  blob: AmbientAuthPolicy,
  inputs: AmbientPolicyInputs,
  provenance: AmbientPolicyProvenance,
): AmbientPolicyDecision {
  const connections = connectionsFrom(inputs);
  const selected = blob.selectedProviderKey
    ? connections.find((item) => item.key === blob.selectedProviderKey)
    : undefined;
  if (!blob.selectedProviderKey || !selected) {
    const policy = freezePolicy({
      ...DISABLED,
      mode: blob.mode,
      provenance: "invalid",
      policyRevision: revisionOf({
        mode: blob.mode,
        selectedProviderKey: blob.selectedProviderKey,
        provenance: "invalid",
      }),
    });
    return {
      policy,
      connection: null,
      eligible: false,
      reason: "provider-removed",
    };
  }
  const automatic =
    blob.allowedTransport === "silent-iframe"
      ? "silent-iframe"
      : blob.allowedTransport === "silent-redirect"
        ? "silent-redirect"
        : null;
  if (
    automatic &&
    !supportsCapability(
      selected,
      automatic === "silent-iframe" ? "silent-iframe" : "silent-redirect",
    )
  ) {
    return {
      policy: freezePolicy({
        ...blob,
        provenance,
        policyRevision: revisionOf(blob),
      }),
      connection: selected,
      eligible: false,
      reason: "unsupported",
    };
  }
  const policy = freezePolicy({
    ...blob,
    provenance,
    selectedProviderKey: selected.key,
    policyRevision: revisionOf({
      mode: blob.mode,
      selectedProviderKey: selected.key,
      tenantAuthority: blob.tenantAuthority,
      allowedTransport: blob.allowedTransport,
      allowVisibleTopLevel: blob.allowVisibleTopLevel,
      permitJitProvisioning: blob.permitJitProvisioning,
      clientId: selected.clientId,
      issuer: selected.issuer,
    }),
  });
  return { policy, connection: selected, eligible: true, reason: "eligible" };
}

function connectionsFrom(inputs: AmbientPolicyInputs): ProviderConnection[] {
  const out: ProviderConnection[] = [];
  for (const idp of inputs.operatorProviders ?? []) {
    const protocol = protocolForIssuer(idp.issuer, idp.providerId);
    const key = providerConnectionKey({
      protocol,
      issuer: idp.issuer,
      clientId: idp.clientId,
    });
    out.push({
      key,
      protocol,
      issuer: trimSlashes(idp.issuer),
      clientId: idp.clientId,
      displayName: idp.label,
      capabilities: capabilitiesFor(protocol),
      ...(protocol === "entra" ? { tenantAuthority: idp.issuer } : undefined),
    });
  }
  return out;
}

function capabilitiesFor(protocol: ProviderConnection["protocol"]) {
  if (protocol === "shoo") {
    return ["interactive-oidc", "local-logout"] as const;
  }
  if (protocol === "entra") {
    return [
      "interactive-oidc",
      "silent-redirect",
      "silent-iframe",
      "account-selection",
      "reauthentication",
      "local-logout",
    ] as const;
  }
  return [
    "interactive-oidc",
    "silent-redirect",
    "account-selection",
    "reauthentication",
    "local-logout",
  ] as const;
}

function readMode(value: BoundaryValue): AmbientAuthMode | null {
  if (
    value === "disabled" ||
    value === "returning-opt-in" ||
    value === "deployment-selected"
  ) {
    return value;
  }
  return null;
}

function readPolicyBlob(
  value: unknown,
  provenance: AmbientPolicyProvenance,
): AmbientAuthPolicy | null {
  if (value === undefined || value === null) return null;
  const raw: BoundaryValue = overlapCast(value);
  if (!isJsonObject(raw) || raw.schemaVersion !== 1) return null;
  const mode = readMode(overlapCast(raw.mode));
  if (!mode) return null;
  if (mode === "disabled") {
    return { ...DISABLED, provenance };
  }
  const selectedProviderKey = isString(raw.selectedProviderKey)
    ? raw.selectedProviderKey
    : undefined;
  if (
    (mode === "deployment-selected" || mode === "returning-opt-in") &&
    selectedProviderKey &&
    !parseProviderConnectionKey(selectedProviderKey)
  ) {
    return null;
  }
  const allowedTransport = readTransport(raw.allowedTransport);
  const cooldownMs = clampInt(
    raw.cooldownMs,
    DEFAULT_COOLDOWN_MS,
    MIN_COOLDOWN_MS,
    MAX_COOLDOWN_MS,
  );
  const timeoutMs = clampInt(
    raw.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  return {
    schemaVersion: 1,
    mode,
    ...(selectedProviderKey
      ? { selectedProviderKey: selectedProviderKey as ProviderConnectionKey }
      : undefined),
    ...(isString(raw.tenantAuthority)
      ? { tenantAuthority: raw.tenantAuthority }
      : undefined),
    allowedTransport,
    allowVisibleTopLevel: raw.allowVisibleTopLevel === true,
    cooldownMs,
    timeoutMs,
    permitJitProvisioning: raw.permitJitProvisioning === true,
    policyRevision: "pending",
    provenance,
  };
}

function readTransport(value: unknown): AmbientTransport {
  if (
    value === "silent-redirect" ||
    value === "silent-iframe" ||
    value === "interactive-continue"
  ) {
    return value;
  }
  return "silent-redirect";
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed: BoundaryValue = overlapCast(value);
  if (!isNumber(parsed) || !Number.isFinite(parsed)) return fallback;
  const n = Math.floor(parsed);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function freezePolicy(policy: AmbientAuthPolicy): AmbientAuthPolicy {
  return Object.freeze({ ...policy });
}

export function revisionOf(fields: Record<string, unknown>): string {
  const json = JSON.stringify(fields, Object.keys(fields).sort());
  let hash = 2166136261;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `v1:${(hash >>> 0).toString(16)}`;
}

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export const USER_AMBIENT_PREFERENCE_KEY = "opensesame:ambient-auth:preference";

export function readUserAmbientPreference(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(USER_AMBIENT_PREFERENCE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeUserAmbientPreference(value: unknown): void {
  try {
    // ast-grep-ignore: ts-localstorage-set
    globalThis.localStorage?.setItem(
      USER_AMBIENT_PREFERENCE_KEY,
      JSON.stringify(value),
    );
  } catch {
    /* quota / private mode */
  }
}

export function clearUserAmbientPreference(): void {
  try {
    globalThis.localStorage?.removeItem(USER_AMBIENT_PREFERENCE_KEY);
  } catch {
    /* storage unavailable */
  }
}
