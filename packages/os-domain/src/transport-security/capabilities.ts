/**
 * Honest capability discovery. "Client presents a certificate" and "server
 * enforces certificates" are different facts; browser vault-key injection is
 * impossible and is reported as such by construction and on decode.
 */

import { type JsonValue, isString } from "../json.js";
import {
  decodeBoolean,
  decodeObject,
  decodeTagged,
  fail,
  succeed,
} from "./codec.js";
import type {
  CapabilityOutcome,
  TransportCapabilities,
  TransportResult,
} from "./types.js";

export const MAX_REASON_BYTES = 512;

const BROWSER_KEY_INJECTION_REASON =
  "a browser cannot attach a vault-held key to its TLS handshake; certificates a browser presents are provisioned outside the app";

/** The one value `browser_vault_key_injection` may hold. */
export function browserVaultKeyInjection(): CapabilityOutcome {
  return { unsupported: { reason: BROWSER_KEY_INJECTION_REASON } };
}

/** The static PWA's capabilities: consume an external certificate, enforce nothing. */
export function browserTransportCapabilities(): TransportCapabilities {
  const noNative = (what: string): CapabilityOutcome => ({
    unsupported: {
      reason: `${what} needs a native runtime; the static app has none`,
    },
  });
  return {
    native_pem: noNative("a PEM identity"),
    managed_certificate: noNative("a managed certificate"),
    spiffe_workload_api: noNative("the SPIFFE Workload API"),
    browser_managed_external: {
      external_provisioning_required: {
        reason:
          "the browser or OS must hold the certificate; the app only selects a remote profile that expects one",
      },
    },
    browser_vault_key_injection: browserVaultKeyInjection(),
    client_presents_certificate: false,
    server_enforces_certificate: false,
  };
}

export function isSupported(outcome: CapabilityOutcome): boolean {
  return outcome === "supported";
}

export function decodeCapabilityOutcome(
  field: string,
  value: JsonValue | undefined,
): TransportResult<CapabilityOutcome> {
  const tagged = decodeTagged(
    field,
    value,
    ["supported"],
    ["unsupported", "external_provisioning_required"],
  );
  if (!tagged.ok) return tagged;
  if (tagged.value.tag === "supported") return succeed("supported");
  const payload = decodeObject(
    `${field}.${tagged.value.tag}`,
    tagged.value.payload,
    ["reason"],
  );
  if (!payload.ok) return payload;
  const reason = payload.value.reason;
  if (!isReason(reason))
    return fail(`${field}: reason must be 1..=${MAX_REASON_BYTES} bytes`);
  return succeed(
    tagged.value.tag === "unsupported"
      ? { unsupported: { reason } }
      : { external_provisioning_required: { reason } },
  );
}

function isReason(value: JsonValue | undefined): value is string {
  return (
    isString(value) && value.length >= 1 && value.length <= MAX_REASON_BYTES
  );
}

const CAPABILITY_OUTCOME_FIELDS = [
  "native_pem",
  "managed_certificate",
  "spiffe_workload_api",
  "browser_managed_external",
  "browser_vault_key_injection",
] as const;

export function decodeTransportCapabilities(
  field: string,
  value: JsonValue | undefined,
): TransportResult<TransportCapabilities> {
  const object = decodeObject(field, value, [
    ...CAPABILITY_OUTCOME_FIELDS,
    "client_presents_certificate",
    "server_enforces_certificate",
  ]);
  if (!object.ok) return object;
  const outcomes: Partial<
    Record<(typeof CAPABILITY_OUTCOME_FIELDS)[number], CapabilityOutcome>
  > = {};
  for (const name of CAPABILITY_OUTCOME_FIELDS) {
    const outcome = decodeCapabilityOutcome(
      `${field}.${name}`,
      object.value[name],
    );
    if (!outcome.ok) return outcome;
    outcomes[name] = outcome.value;
  }
  const presents = decodeBoolean(
    `${field}.client_presents_certificate`,
    object.value.client_presents_certificate,
  );
  if (!presents.ok) return presents;
  const enforces = decodeBoolean(
    `${field}.server_enforces_certificate`,
    object.value.server_enforces_certificate,
  );
  if (!enforces.ok) return enforces;
  const injection = outcomes.browser_vault_key_injection;
  if (
    injection === undefined ||
    injection === "supported" ||
    !("unsupported" in injection)
  ) {
    return fail(`${field}.browser_vault_key_injection: must be unsupported`);
  }
  return succeed({
    native_pem: outcomes.native_pem ?? "supported",
    managed_certificate: outcomes.managed_certificate ?? "supported",
    spiffe_workload_api: outcomes.spiffe_workload_api ?? "supported",
    browser_managed_external: outcomes.browser_managed_external ?? "supported",
    browser_vault_key_injection: injection,
    client_presents_certificate: presents.value,
    server_enforces_certificate: enforces.value,
  });
}
