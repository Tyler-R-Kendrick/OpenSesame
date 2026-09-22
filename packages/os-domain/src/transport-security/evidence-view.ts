/**
 * The audit-safe view of verified peer evidence. Decoding one proves the
 * document was well-formed and nothing more: no code path turns a view into
 * trusted evidence, and a `verified` flag is an unknown field.
 */

import type { JsonValue } from "../json.js";
import {
  attempt,
  decodeEnum,
  decodeGeneration,
  decodeId,
  decodeObject,
  decodeThumbprint,
  decodeTimestamp,
  decodeTrustProfileRef,
  fail,
  need,
  succeed,
} from "./codec.js";
import { decodeSelector } from "./selectors.js";
import {
  EVIDENCE_SOURCES,
  type ObservedAuthentication,
  type PeerEvidenceView,
  type PeerIdentitySelector,
  TLS_VERSIONS,
  TRANSPORT_POLICIES,
  type TransportResult,
} from "./types.js";

const EVIDENCE_FIELDS = [
  "source",
  "identities",
  "leaf_thumbprint_sha256",
  "not_before",
  "not_after",
  "trust_profile",
  "trust_generation",
  "credential_generation",
  "listener",
  "policy",
  "tls_version",
  "authenticated_at",
  "usable_until",
] as const;

function decodeSelectors(
  field: string,
  value: JsonValue | undefined,
): TransportResult<readonly PeerIdentitySelector[]> {
  if (!Array.isArray(value)) return fail(`${field}: must be an array`);
  const out: PeerIdentitySelector[] = [];
  for (const item of value) {
    const selector = decodeSelector(field, item);
    if (!selector.ok) return selector;
    out.push(selector.value);
  }
  return succeed(out);
}

export function decodePeerEvidenceView(
  field: string,
  value: JsonValue | undefined,
): TransportResult<PeerEvidenceView> {
  return attempt(() => {
    const raw = need(decodeObject(field, value, EVIDENCE_FIELDS, ["ingress"]));
    const at = (name: string) => `${field}.${name}`;
    const ingress =
      raw.ingress === undefined || raw.ingress === null
        ? null
        : need(decodePeerEvidenceView(at("ingress"), raw.ingress));
    return {
      source: need(decodeEnum(at("source"), EVIDENCE_SOURCES, raw.source)),
      identities: need(decodeSelectors(at("identities"), raw.identities)),
      leaf_thumbprint_sha256: need(
        decodeThumbprint(
          at("leaf_thumbprint_sha256"),
          raw.leaf_thumbprint_sha256,
        ),
      ),
      not_before: need(decodeTimestamp(at("not_before"), raw.not_before)),
      not_after: need(decodeTimestamp(at("not_after"), raw.not_after)),
      trust_profile: need(
        decodeTrustProfileRef(at("trust_profile"), raw.trust_profile),
      ),
      trust_generation: need(
        decodeGeneration(at("trust_generation"), raw.trust_generation),
      ),
      credential_generation: need(
        decodeGeneration(
          at("credential_generation"),
          raw.credential_generation,
        ),
      ),
      listener: need(decodeId(at("listener"), raw.listener)),
      policy: need(decodeEnum(at("policy"), TRANSPORT_POLICIES, raw.policy)),
      tls_version: need(
        decodeEnum(at("tls_version"), TLS_VERSIONS, raw.tls_version),
      ),
      authenticated_at: need(
        decodeTimestamp(at("authenticated_at"), raw.authenticated_at),
      ),
      usable_until: need(decodeTimestamp(at("usable_until"), raw.usable_until)),
      ingress,
    };
  });
}

export function decodeObservedAuthentication(
  field: string,
  value: JsonValue | undefined,
): TransportResult<ObservedAuthentication | null> {
  if (value === undefined || value === null) return succeed(null);
  return attempt(() => {
    const raw = need(
      decodeObject(field, value, [
        "at",
        "observer",
        "target",
        "generation",
        "peer",
      ]),
    );
    return {
      at: need(decodeTimestamp(`${field}.at`, raw.at)),
      observer: need(decodeId(`${field}.observer`, raw.observer)),
      target: need(decodeId(`${field}.target`, raw.target)),
      generation: need(decodeGeneration(`${field}.generation`, raw.generation)),
      peer: need(decodePeerEvidenceView(`${field}.peer`, raw.peer)),
    };
  });
}
