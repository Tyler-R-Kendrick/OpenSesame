/**
 * Bounded preview of a join document before anything is accepted (S03).
 *
 * TRUST-02 / TRUST-07: the preview follows no URL, activates nothing and
 * trusts nothing about the document's own structure. It reads a fixed set of
 * members, caps every list and string, filters ids against the catalog and
 * the distribution ceiling, and lists what it could not place as `absent`.
 * Acceptance is a different path: `verifyPolicyEnvelope` for the signature,
 * S01's `parseInstancePolicy` for the payload, `checkRevision` for order.
 */
import type {
  CapabilityCatalog,
  DistributionContract,
  InstanceCapabilityPolicy,
} from "@opensesame/capability-composition";
import {
  type BoundaryValue,
  type JsonValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { SignedPolicyEnvelope } from "./envelope.js";
import { isDigest } from "./digest.js";
import {
  type PolicyPublicJwk,
  jwkThumbprintHex,
  keyFingerprint,
  policyPublicJwk,
} from "./trust-keys.js";

export const MAX_JOIN_DOCUMENT_CHARS = 64 * 1024;
const MAX_IDS = 256;
const MAX_FIELD = 256;
/** Members a join document may carry and that this preview will read. */
const READ_MEMBERS = new Set([
  "schemaVersion", "kind", "instanceId", "revision", "alg", "kid", "payloadDigest",
  "payload", "notBefore", "expires", "allowedOrigins", "signature", "publicKey",
  // Bare-policy members (a document that is the payload itself).
  "presetProvenance", "capabilities", "network", "updates",
]);

export type JoinPreviewEntry = Readonly<{
  id: string;
  title: string;
  /** Present in this build; a required capability that is not cannot be joined. */
  distributed: boolean;
}>;

export type JoinPreview = Readonly<
  | {
      ok: true;
      instanceId: string;
      revision: string;
      signed: boolean;
      kid: string | null;
      /** `sha256:<thumbprint hex>` of the embedded key, for the person to compare. */
      keyFingerprint: string | null;
      /** True when the embedded key's thumbprint is not the envelope's kid. */
      kidMismatch: boolean;
      payloadDigest: string | null;
      required: readonly JoinPreviewEntry[];
      optional: readonly JoinPreviewEntry[];
      prohibited: readonly JoinPreviewEntry[];
      /** Ids the document names that this catalog does not know. */
      absent: readonly string[];
      network: Readonly<{
        externalServices: "allow" | "deny" | "unknown";
        allowedServiceOrigins: readonly string[];
      }>;
      window: Readonly<{ notBefore: string | null; expires: string | null }>;
      allowedOrigins: readonly string[];
      /** Members the document carried that the preview deliberately ignored. */
      ignoredMembers: readonly string[];
      provenance: "invitation-unverified";
    }
  | { ok: false; reason: "malformed" | "too-large" | "wrong-kind" }
>;

type Body = Readonly<Record<string, JsonValue | undefined>>;

function shortString(value: JsonValue | undefined): string | null {
  return isString(value) && value.length > 0 && value.length <= MAX_FIELD ? value : null;
}

function idList(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value.slice(0, MAX_IDS)) {
    const id = shortString(entry);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

function place(
  ids: readonly string[],
  catalog: CapabilityCatalog,
  ceiling: DistributionContract,
  absent: Set<string>,
): JoinPreviewEntry[] {
  const entries: JoinPreviewEntry[] = [];
  for (const id of ids) {
    const descriptor = catalog.capabilities.find((c) => c.id === id);
    if (descriptor === undefined) {
      absent.add(id);
      continue;
    }
    entries.push({
      id,
      title: descriptor.title,
      distributed: ceiling.capabilityIds.includes(id),
    });
  }
  return entries;
}

type NetworkPreview = Readonly<{
  externalServices: "allow" | "deny" | "unknown";
  allowedServiceOrigins: readonly string[];
}>;

function readNetwork(value: JsonValue | undefined): NetworkPreview {
  const declared = isJsonObject(value) ? value.externalServices : undefined;
  const externalServices: NetworkPreview["externalServices"] =
    declared === "allow" || declared === "deny" ? declared : "unknown";
  const allowedServiceOrigins = isJsonObject(value)
    ? idList(value.allowedServiceOrigins).filter((origin) => {
        try {
          return new URL(origin).origin === origin;
        } catch {
          return false;
        }
      })
    : [];
  return { externalServices, allowedServiceOrigins };
}

async function embeddedKey(
  value: JsonValue | undefined,
  kid: string | null,
): Promise<{ fingerprint: string | null; mismatch: boolean }> {
  if (value === undefined) return { fingerprint: null, mismatch: false };
  const jwk: PolicyPublicJwk | null = policyPublicJwk(value);
  if (jwk === null) return { fingerprint: null, mismatch: kid !== null };
  const thumbprint = await jwkThumbprintHex(jwk);
  return {
    fingerprint: keyFingerprint(thumbprint),
    mismatch: kid !== null && kid !== thumbprint,
  };
}

/** Bare policy or signed envelope: the policy body is the envelope's payload when present. */
function policyBody(document: Body): Body | null {
  if (document.kind === "InstanceCapabilityPolicy" && isJsonObject(document.payload)) {
    return document.payload;
  }
  if (document.kind === "InstanceCapabilityPolicy" && document.payload === undefined) {
    return document;
  }
  return null;
}

export async function previewJoinDocument(
  document: BoundaryValue | InstanceCapabilityPolicy | SignedPolicyEnvelope,
  ceiling: DistributionContract,
  catalog: CapabilityCatalog,
): Promise<JoinPreview> {
  // SAFETY: a typed document is JSON data; the preview re-reads every member.
  const candidate: BoundaryValue = overlapCast(document);
  if (!isJsonObject(candidate)) return { ok: false, reason: "malformed" };
  if (JSON.stringify(candidate).length > MAX_JOIN_DOCUMENT_CHARS)
    return { ok: false, reason: "too-large" };
  if (candidate.kind !== "InstanceCapabilityPolicy") return { ok: false, reason: "wrong-kind" };
  const body = policyBody(candidate);
  if (body === null) return { ok: false, reason: "malformed" };
  const instanceId = shortString(body.instanceId) ?? shortString(candidate.instanceId);
  const revision = shortString(body.revision) ?? shortString(candidate.revision);
  if (instanceId === null || revision === null) return { ok: false, reason: "malformed" };
  const signed = isString(candidate.signature);
  const kid = signed ? shortString(candidate.kid) : null;
  const key = await embeddedKey(candidate.publicKey, kid);
  const capabilities = isJsonObject(body.capabilities) ? body.capabilities : {};
  const absent = new Set<string>();
  const required = place(idList(capabilities.required), catalog, ceiling, absent);
  const optional = place(idList(capabilities.optional), catalog, ceiling, absent);
  const prohibited = place(idList(capabilities.prohibited), catalog, ceiling, absent);
  return {
    ok: true,
    instanceId,
    revision,
    signed,
    kid,
    keyFingerprint: key.fingerprint,
    kidMismatch: key.mismatch,
    payloadDigest: isDigest(candidate.payloadDigest) ? candidate.payloadDigest : null,
    required,
    optional,
    prohibited,
    absent: [...absent].sort(),
    network: readNetwork(body.network),
    window: {
      notBefore: shortString(candidate.notBefore),
      expires: shortString(candidate.expires),
    },
    allowedOrigins: idList(candidate.allowedOrigins),
    ignoredMembers: Object.keys(candidate).filter((k) => !READ_MEMBERS.has(k)).sort(),
    provenance: "invitation-unverified",
  };
}
