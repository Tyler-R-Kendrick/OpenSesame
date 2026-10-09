/**
 * Service binding admission for the Identity plane (CONTRACT §3
 * `ServiceBindingSet::resolve`): default deny, exactly one enabled,
 * unrevoked, in-window binding whose trust profile AND peer AND purpose
 * match, then the operation must be listed.
 *
 * The binding document, its decoder and the resolve semantics are the
 * canonical ones in `@opensesame/os-domain` (SW-CONTRACT); this module adds
 * the Identity-plane admission wrapper over verified peer evidence.
 */
import {
  type BindingPurpose,
  type ServiceBinding,
  type ServiceBindingSet,
  type TransportErrorCode,
  bindingAllowsOperation,
  parseServiceBindingSet,
  resolveServiceBinding,
} from "@opensesame/os-domain";
import type { VerifiedPeer } from "./peer-evidence.js";

export type { BindingPurpose, ServiceBinding, ServiceBindingSet };

export const EMPTY_BINDINGS: ServiceBindingSet = { revision: 1, bindings: [] };

/** Snake_case codes mirror `TransportError::code()`. */
export type AdmissionErrorCode = TransportErrorCode;

export type AdmissionResult =
  | { ok: true; caller: ServiceCaller }
  | { ok: false; code: AdmissionErrorCode };

/** Built by admission, never deserialized (CONTRACT §3 `ServiceCaller`). */
export interface ServiceCaller {
  peer: VerifiedPeer;
  binding: ServiceBinding;
  /** The originating client when `peer` came through a trusted ingress. */
  originating?: VerifiedPeer;
}

/**
 * Admit a verified peer for one deployment-scoped service operation.
 * Checks, in order: the evidence is still usable now, the binding resolves,
 * and the operation is listed. A bound service identity can do nothing that
 * is not listed (AT-MAPPING-SCOPE).
 */
export function admitService(
  set: ServiceBindingSet,
  peer: VerifiedPeer,
  purpose: BindingPurpose,
  operation: string,
  now: Date,
  originating?: VerifiedPeer,
): AdmissionResult {
  if (!peer.usableAt(now)) return { ok: false, code: "evidence_expired" };
  const resolved = resolveServiceBinding(
    set,
    "deployment",
    peer.trustProfile(),
    peer.identities(),
    purpose,
    now,
  );
  if (!resolved.ok) return { ok: false, code: resolved.error.code };
  if (!bindingAllowsOperation(resolved.value, operation)) {
    return { ok: false, code: "peer_disallowed" };
  }
  const caller: ServiceCaller = { peer, binding: resolved.value };
  if (originating) caller.originating = originating;
  return { ok: true, caller };
}

/** Parse a `ServiceBindingSet` document; unknown fields and bad ids reject. */
export function parseServiceBindings(raw: string): ServiceBindingSet {
  const parsed = parseServiceBindingSet(raw);
  if (!parsed.ok) {
    throw new Error(
      `service bindings file is invalid: ${parsed.error.detail ?? parsed.error.code}`,
    );
  }
  return parsed.value;
}
