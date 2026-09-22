/**
 * Service bindings: decoding with unknown-field rejection, structural
 * validation, and default-deny resolution — the same rules, in the same
 * order, as `ServiceBindingSet::resolve_scoped` in the Rust plane.
 */

import type { JsonValue } from "../json.js";
import {
  attempt,
  decodeBoolean,
  decodeEnum,
  decodeGeneration,
  decodeId,
  decodeObject,
  decodeStringList,
  decodeTagged,
  decodeThumbprint,
  decodeTimestamp,
  decodeTrustProfileRef,
  fail,
  failWith,
  need,
  succeed,
} from "./codec.js";
import { decodeSelector, selectorEntry, selectorsEqual } from "./selectors.js";
import {
  BINDING_PURPOSES,
  type BindingPurpose,
  type BindingScope,
  type PeerIdentitySelector,
  type ServiceBinding,
  type ServiceBindingSet,
  type TransportResult,
  type TrustProfileRef,
} from "./types.js";

export const MAX_BINDINGS = 1024;
export const MAX_LIST_ENTRIES = 256;

const BINDING_FIELDS = [
  "id",
  "revision",
  "enabled",
  "revoked",
  "scope",
  "trust_profile",
  "peer",
  "service_principal",
  "purpose",
  "allowed_operations",
  "allowed_audiences",
  "denied_thumbprints",
] as const;

export function decodeBindingScope(
  field: string,
  value: JsonValue | undefined,
): TransportResult<BindingScope> {
  const tagged = decodeTagged(field, value, ["deployment"], ["organization"]);
  if (!tagged.ok) return tagged;
  if (tagged.value.tag === "deployment") return succeed("deployment");
  const payload = decodeObject(`${field}.organization`, tagged.value.payload, [
    "organization_id",
  ]);
  if (!payload.ok) return payload;
  const id = decodeId(
    `${field}.organization.organization_id`,
    payload.value.organization_id,
  );
  return id.ok ? succeed({ organization: { organization_id: id.value } }) : id;
}

export function scopesEqual(a: BindingScope, b: BindingScope): boolean {
  if (a === "deployment" || b === "deployment") return a === b;
  return a.organization.organization_id === b.organization.organization_id;
}

function decodeNotAfter(
  field: string,
  value: JsonValue | undefined,
): TransportResult<string | null> {
  if (value === undefined || value === null) return succeed(null);
  return decodeTimestamp(field, value);
}

export function decodeServiceBinding(
  field: string,
  value: JsonValue | undefined,
): TransportResult<ServiceBinding> {
  return attempt(() => {
    const raw = need(decodeObject(field, value, BINDING_FIELDS, ["not_after"]));
    const id = need(decodeId(`${field}.id`, raw.id));
    const at = (name: string) => `${field}[${id}].${name}`;
    const operations = need(
      decodeStringList(
        at("allowed_operations"),
        raw.allowed_operations,
        decodeId,
        MAX_LIST_ENTRIES,
      ),
    );
    if (operations.length === 0) {
      need(fail(`${at("allowed_operations")}: must not be empty`));
    }
    return {
      id,
      revision: need(decodeGeneration(at("revision"), raw.revision, 1)),
      enabled: need(decodeBoolean(at("enabled"), raw.enabled)),
      revoked: need(decodeBoolean(at("revoked"), raw.revoked)),
      scope: need(decodeBindingScope(at("scope"), raw.scope)),
      trust_profile: need(
        decodeTrustProfileRef(at("trust_profile"), raw.trust_profile),
      ),
      peer: need(decodeSelector(at("peer"), raw.peer)),
      service_principal: need(
        decodeId(at("service_principal"), raw.service_principal),
      ),
      purpose: need(decodeEnum(at("purpose"), BINDING_PURPOSES, raw.purpose)),
      allowed_operations: operations,
      allowed_audiences: need(
        decodeStringList(
          at("allowed_audiences"),
          raw.allowed_audiences,
          decodeId,
          MAX_LIST_ENTRIES,
        ),
      ),
      not_after: need(decodeNotAfter(at("not_after"), raw.not_after)),
      denied_thumbprints: need(
        decodeStringList(
          at("denied_thumbprints"),
          raw.denied_thumbprints,
          decodeThumbprint,
          MAX_LIST_ENTRIES,
        ),
      ),
    };
  });
}

export function decodeServiceBindingSet(
  value: JsonValue | undefined,
): TransportResult<ServiceBindingSet> {
  const object = decodeObject("service_bindings", value, [
    "revision",
    "bindings",
  ]);
  if (!object.ok) return object;
  const revision = decodeGeneration(
    "service_bindings.revision",
    object.value.revision,
    1,
  );
  if (!revision.ok) return revision;
  const rawBindings = object.value.bindings;
  if (!Array.isArray(rawBindings))
    return fail("service_bindings.bindings: must be an array");
  if (rawBindings.length > MAX_BINDINGS)
    return fail(
      `service_bindings.bindings: more than ${MAX_BINDINGS} bindings`,
    );
  const bindings: ServiceBinding[] = [];
  for (const raw of rawBindings) {
    const binding = decodeServiceBinding("service_bindings.bindings", raw);
    if (!binding.ok) return binding;
    if (bindings.some((seen) => seen.id === binding.value.id)) {
      return fail(`service_bindings: duplicate id ${binding.value.id}`);
    }
    bindings.push(binding.value);
  }
  return succeed({ revision: revision.value, bindings });
}

/** Parse the JSON text of a binding set (file, stored value, PUT body). */
export function parseServiceBindingSet(
  json: string,
): TransportResult<ServiceBindingSet> {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail("service bindings: not JSON");
  }
  return decodeServiceBindingSet(parsed);
}

/** Enabled, not revoked, and inside its window at `now`. */
export function isBindingLive(binding: ServiceBinding, now: Date): boolean {
  if (!binding.enabled || binding.revoked) return false;
  return (
    binding.not_after === null || now.getTime() < Date.parse(binding.not_after)
  );
}

export function bindingAllowsOperation(
  binding: ServiceBinding,
  operation: string,
): boolean {
  return binding.allowed_operations.includes(operation);
}

export function bindingAllowsAudience(
  binding: ServiceBinding,
  audience: string,
): boolean {
  return binding.allowed_audiences.includes(audience);
}

/**
 * Default deny. Exactly one live binding in `scope` whose trust profile,
 * peer selector, and purpose all match must exist. Errors, in priority
 * order: `peer_not_bound`, `evidence_revoked` (a presented thumbprint is
 * denied by any matching binding, live or not), `binding_disabled`,
 * `ambiguous_binding`.
 */
export function resolveServiceBinding(
  set: ServiceBindingSet,
  scope: BindingScope,
  profile: TrustProfileRef,
  presented: readonly PeerIdentitySelector[],
  purpose: BindingPurpose,
  now: Date,
): TransportResult<ServiceBinding> {
  const matching = set.bindings.filter(
    (binding) =>
      scopesEqual(binding.scope, scope) &&
      binding.trust_profile.name === profile.name &&
      binding.purpose === purpose &&
      presented.some((selector) => selectorsEqual(selector, binding.peer)),
  );
  if (matching.length === 0) return failWith("peer_not_bound");
  const thumbprints = presented
    .map(selectorEntry)
    .filter(([kind]) => kind === "leaf_thumbprint_sha256")
    .map(([, value]) => value);
  const denied = thumbprints.some((thumbprint) =>
    matching.some((binding) => binding.denied_thumbprints.includes(thumbprint)),
  );
  if (denied) return failWith("evidence_revoked");
  const live = matching.filter((binding) => isBindingLive(binding, now));
  const [first] = live;
  if (first === undefined) return failWith("binding_disabled");
  if (live.length > 1) return failWith("ambiguous_binding");
  return succeed(first);
}
