/**
 * Status views: independent dimensions (desired, credential, runtime,
 * observed, enforcement), never one collapsed lifecycle. A decoded view is a
 * DTO and certifies nothing.
 */

import type { JsonValue } from "../json.js";
import { decodeTransportCapabilities } from "./capabilities.js";
import {
  attempt,
  decodeBoolean,
  decodeEnum,
  decodeGeneration,
  decodeId,
  decodeObject,
  decodeTagged,
  decodeTimestamp,
  fail,
  need,
  succeed,
} from "./codec.js";
import { decodeObservedAuthentication } from "./evidence-view.js";
import {
  CUSTODIES,
  type CredentialStatus,
  type EnforcementStatus,
  IDENTITY_SOURCE_KINDS,
  type RuntimeStatus,
  TRANSPORT_ERROR_CODES,
  TRANSPORT_POLICIES,
  type TransportResult,
  type TransportStatusView,
} from "./types.js";

export function decodeCredentialStatus(
  field: string,
  value: JsonValue | undefined,
): TransportResult<CredentialStatus> {
  const tagged = decodeTagged(
    field,
    value,
    [
      "unconfigured",
      "external_provisioning_required",
      "unsupported_in_browser",
    ],
    ["configured", "expired", "revoked"],
  );
  if (!tagged.ok) return tagged;
  const { tag, payload } = tagged.value;
  if (
    tag === "unconfigured" ||
    tag === "external_provisioning_required" ||
    tag === "unsupported_in_browser"
  )
    return succeed(tag);
  if (tag === "expired" || tag === "revoked") {
    const object = decodeObject(`${field}.${tag}`, payload, ["generation"]);
    if (!object.ok) return object;
    const generation = decodeGeneration(
      `${field}.${tag}.generation`,
      object.value.generation,
    );
    if (!generation.ok) return generation;
    return succeed(
      tag === "expired"
        ? { expired: { generation: generation.value } }
        : { revoked: { generation: generation.value } },
    );
  }
  const object = decodeObject(`${field}.configured`, payload, [
    "custody",
    "generation",
    "not_after",
    "kind",
  ]);
  if (!object.ok) return object;
  const custody = decodeEnum(
    `${field}.configured.custody`,
    CUSTODIES,
    object.value.custody,
  );
  const generation = decodeGeneration(
    `${field}.configured.generation`,
    object.value.generation,
  );
  const notAfter = decodeTimestamp(
    `${field}.configured.not_after`,
    object.value.not_after,
  );
  const kind = decodeEnum(
    `${field}.configured.kind`,
    IDENTITY_SOURCE_KINDS,
    object.value.kind,
  );
  if (!custody.ok) return custody;
  if (!generation.ok) return generation;
  if (!notAfter.ok) return notAfter;
  if (!kind.ok) return kind;
  return succeed({
    configured: {
      custody: custody.value,
      generation: generation.value,
      not_after: notAfter.value,
      kind: kind.value,
    },
  });
}

export function decodeRuntimeStatus(
  field: string,
  value: JsonValue | undefined,
): TransportResult<RuntimeStatus> {
  const tagged = decodeTagged(
    field,
    value,
    ["not_loaded"],
    ["loaded", "reload_failed"],
  );
  if (!tagged.ok) return tagged;
  const { tag, payload } = tagged.value;
  if (tag === "not_loaded") return succeed("not_loaded");
  const object = decodeObject(`${field}.${tag}`, payload, [
    "generation",
    tag === "loaded" ? "loaded_at" : "code",
  ]);
  if (!object.ok) return object;
  const generation = decodeGeneration(
    `${field}.${tag}.generation`,
    object.value.generation,
  );
  if (!generation.ok) return generation;
  if (tag === "loaded") {
    const loadedAt = decodeTimestamp(
      `${field}.loaded.loaded_at`,
      object.value.loaded_at,
    );
    return loadedAt.ok
      ? succeed({
          loaded: { generation: generation.value, loaded_at: loadedAt.value },
        })
      : loadedAt;
  }
  const code = decodeEnum(
    `${field}.reload_failed.code`,
    TRANSPORT_ERROR_CODES,
    object.value.code,
  );
  return code.ok
    ? succeed({
        reload_failed: { generation: generation.value, code: code.value },
      })
    : code;
}

function decodeStaleEnforcement(
  field: string,
  payload: JsonValue | undefined,
): TransportResult<EnforcementStatus> {
  return attempt(() => {
    const raw = need(
      decodeObject(field, payload, [
        "verified_at",
        "generation",
        "current_generation",
      ]),
    );
    return {
      stale: {
        verified_at: need(
          decodeTimestamp(`${field}.verified_at`, raw.verified_at),
        ),
        generation: need(
          decodeGeneration(`${field}.generation`, raw.generation),
        ),
        current_generation: need(
          decodeGeneration(
            `${field}.current_generation`,
            raw.current_generation,
          ),
        ),
      },
    };
  });
}

const VERIFIED_FIELDS = [
  "at",
  "target",
  "generation",
  "accepted_with_certificate",
  "rejected_without_certificate",
  "fresh_until",
] as const;

function decodeVerifiedEnforcement(
  field: string,
  payload: JsonValue | undefined,
): TransportResult<EnforcementStatus> {
  return attempt(() => {
    const raw = need(decodeObject(field, payload, VERIFIED_FIELDS));
    return {
      verified: {
        at: need(decodeTimestamp(`${field}.at`, raw.at)),
        target: need(decodeId(`${field}.target`, raw.target)),
        generation: need(
          decodeGeneration(`${field}.generation`, raw.generation),
        ),
        accepted_with_certificate: need(
          decodeBoolean(
            `${field}.accepted_with_certificate`,
            raw.accepted_with_certificate,
          ),
        ),
        rejected_without_certificate: need(
          decodeBoolean(
            `${field}.rejected_without_certificate`,
            raw.rejected_without_certificate,
          ),
        ),
        fresh_until: need(
          decodeTimestamp(`${field}.fresh_until`, raw.fresh_until),
        ),
      },
    };
  });
}

export function decodeEnforcementStatus(
  field: string,
  value: JsonValue | undefined,
): TransportResult<EnforcementStatus> {
  const tagged = decodeTagged(
    field,
    value,
    ["unverified"],
    ["verified", "stale"],
  );
  if (!tagged.ok) return tagged;
  const { tag, payload } = tagged.value;
  if (tag === "unverified") return succeed("unverified");
  if (tag === "stale") return decodeStaleEnforcement(`${field}.stale`, payload);
  return decodeVerifiedEnforcement(`${field}.verified`, payload);
}

/** True only for a `verified` probe that both accepted a certificate and rejected its absence. */
export function enforcementProven(status: EnforcementStatus): boolean {
  return (
    status !== "unverified" &&
    "verified" in status &&
    status.verified.accepted_with_certificate &&
    status.verified.rejected_without_certificate
  );
}

/** A `verified` taken under another generation, or past `fresh_until`, becomes `stale` (AT-EVIDENCE-STALE). */
export function reconcileEnforcement(
  status: EnforcementStatus,
  currentGeneration: number,
  now: Date,
): EnforcementStatus {
  if (status === "unverified" || !("verified" in status)) return status;
  const { at, generation, fresh_until: freshUntil } = status.verified;
  if (
    generation === currentGeneration &&
    now.getTime() < Date.parse(freshUntil)
  )
    return status;
  return {
    stale: {
      verified_at: at,
      generation,
      current_generation: currentGeneration,
    },
  };
}

export function runtimeGeneration(status: RuntimeStatus): number | null {
  if (status === "not_loaded") return null;
  return "loaded" in status
    ? status.loaded.generation
    : status.reload_failed.generation;
}

const STATUS_FIELDS = [
  "target",
  "desired",
  "credential",
  "runtime",
  "enforcement",
  "capabilities",
] as const;

function probeTarget(status: EnforcementStatus): string | null {
  if (status === "unverified" || !("verified" in status)) return null;
  return status.verified.target;
}

export function decodeTransportStatusView(
  value: JsonValue | undefined,
): TransportResult<TransportStatusView> {
  const field = "status";
  return attempt(() => {
    const raw = need(decodeObject(field, value, STATUS_FIELDS, ["observed"]));
    const target = need(decodeId(`${field}.target`, raw.target));
    const observed = need(
      decodeObservedAuthentication(`${field}.observed`, raw.observed),
    );
    const enforcement = need(
      decodeEnforcementStatus(`${field}.enforcement`, raw.enforcement),
    );
    if (observed !== null && observed.target !== target) {
      need(
        fail(`${field}.observed.target: observation is about another target`),
      );
    }
    const probed = probeTarget(enforcement);
    if (probed !== null && probed !== target) {
      need(fail(`${field}.enforcement.target: probe is about another target`));
    }
    return {
      target,
      desired: need(
        decodeEnum(`${field}.desired`, TRANSPORT_POLICIES, raw.desired),
      ),
      credential: need(
        decodeCredentialStatus(`${field}.credential`, raw.credential),
      ),
      runtime: need(decodeRuntimeStatus(`${field}.runtime`, raw.runtime)),
      observed,
      enforcement,
      capabilities: need(
        decodeTransportCapabilities(`${field}.capabilities`, raw.capabilities),
      ),
    };
  });
}
