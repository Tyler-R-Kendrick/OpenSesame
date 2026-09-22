/**
 * Transport-security wire schemas (ADR 0132): zod mirrors of
 * `opensesame_domain::transport`, sharing one JSON corpus with the Rust plane
 * (`fixtures/transport-security`). Fields are snake_case because the wire is;
 * every object is `.strict()`, timestamps must be strict RFC 3339 with an
 * offset and canonicalize to UTC milliseconds, enums reject unknown variants,
 * and nothing coerces. The scalar grammars come from os-domain so both
 * TypeScript entry points read a value the same way.
 */

import {
  BINDING_PURPOSES,
  CUSTODIES,
  EVIDENCE_SOURCES,
  IDENTITY_SOURCE_KINDS,
  MAX_BINDINGS,
  MAX_LIST_ENTRIES,
  MAX_REASON_BYTES,
  TLS_VERSIONS,
  TRANSPORT_ERROR_CODES,
  TRANSPORT_POLICIES,
  TRUST_PROFILE_KINDS,
  canonicalTimestamp,
  decodeSelector,
  isValidId,
  isValidRefName,
  isValidThumbprint,
  parseRfc3339,
} from "@opensesame/os-domain";
import { z } from "zod";

export const TransportPolicySchema = z.enum(TRANSPORT_POLICIES);
export const TlsVersionSchema = z.enum(TLS_VERSIONS);
export const IdentitySourceKindSchema = z.enum(IDENTITY_SOURCE_KINDS);
export const CustodySchema = z.enum(CUSTODIES);
export const TrustProfileKindSchema = z.enum(TRUST_PROFILE_KINDS);
export const EvidenceSourceSchema = z.enum(EVIDENCE_SOURCES);
export const BindingPurposeSchema = z.enum(BINDING_PURPOSES);
export const TransportErrorCodeSchema = z.enum(TRANSPORT_ERROR_CODES);

/** Strict RFC 3339 with an offset; output is the canonical UTC-millisecond form. */
export const TransportTimestampSchema = z.string().transform((value, ctx) => {
  const parsed = parseRfc3339(value);
  if (parsed === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "timestamp must be strict RFC 3339 with an offset",
    });
    return z.NEVER;
  }
  return canonicalTimestamp(parsed);
});

export const TransportIdSchema = z
  .string()
  .refine(isValidId, "printable ASCII, 1..=128 bytes");
export const ThumbprintSchema = z
  .string()
  .refine(isValidThumbprint, "64 lowercase hex characters");
export const GenerationSchema = z.number().int().nonnegative().safe();
export const RevisionSchema = z.number().int().positive().safe();

const RefSchema = z
  .object({
    name: z.string().refine(isValidRefName, "^[a-z0-9][a-z0-9._-]{0,63}$"),
  })
  .strict();
export const TrustProfileRefSchema = RefSchema;
export const IdentitySourceRefSchema = RefSchema;

const wellFormedSelector = (value: { [key: string]: string }) =>
  decodeSelector("peer", value).ok;

/** Exact-match only. No wildcards, no CN, no email, no IP. */
export const PeerIdentitySelectorSchema = z.union([
  z
    .object({ spiffe_id: z.string() })
    .strict()
    .refine(wellFormedSelector, "spiffe_id: malformed selector"),
  z
    .object({ dns_name: z.string() })
    .strict()
    .refine(wellFormedSelector, "dns_name: malformed selector"),
  z
    .object({ uri_san: z.string() })
    .strict()
    .refine(wellFormedSelector, "uri_san: malformed selector"),
  z
    .object({ leaf_thumbprint_sha256: z.string() })
    .strict()
    .refine(wellFormedSelector, "leaf_thumbprint_sha256: malformed selector"),
]);

export const BindingScopeSchema = z.union([
  z.literal("deployment"),
  z
    .object({
      organization: z.object({ organization_id: TransportIdSchema }).strict(),
    })
    .strict(),
]);

const uniqueList = <S extends z.ZodTypeAny>(item: S) =>
  z
    .array(item)
    .max(MAX_LIST_ENTRIES)
    .refine((list) => new Set(list).size === list.length, "duplicate entry");

export const ServiceBindingSchema = z
  .object({
    id: TransportIdSchema,
    revision: RevisionSchema,
    enabled: z.boolean(),
    revoked: z.boolean(),
    scope: BindingScopeSchema,
    trust_profile: TrustProfileRefSchema,
    peer: PeerIdentitySelectorSchema,
    service_principal: TransportIdSchema,
    purpose: BindingPurposeSchema,
    allowed_operations: uniqueList(TransportIdSchema).refine(
      (list) => list.length > 0,
      "allowed_operations must not be empty",
    ),
    allowed_audiences: uniqueList(TransportIdSchema),
    not_after: TransportTimestampSchema.nullable()
      .optional()
      .transform((value) => value ?? null),
    denied_thumbprints: uniqueList(ThumbprintSchema),
  })
  .strict();

export const ServiceBindingSetSchema = z
  .object({
    revision: RevisionSchema,
    bindings: z.array(ServiceBindingSchema).max(MAX_BINDINGS),
  })
  .strict()
  .refine(
    (set) =>
      new Set(set.bindings.map((b) => b.id)).size === set.bindings.length,
    "duplicate binding id",
  );

/** `PUT /api/v1/operator/transport/bindings` body: the whole set, CAS on `revision`. */
export const TransportBindingsPutSchema = ServiceBindingSetSchema;

const ReasonSchema = z.string().min(1).max(MAX_REASON_BYTES);
const UnsupportedOutcomeSchema = z
  .object({ unsupported: z.object({ reason: ReasonSchema }).strict() })
  .strict();
export const CapabilityOutcomeSchema = z.union([
  z.literal("supported"),
  UnsupportedOutcomeSchema,
  z
    .object({
      external_provisioning_required: z
        .object({ reason: ReasonSchema })
        .strict(),
    })
    .strict(),
]);

export const TransportCapabilitiesSchema = z
  .object({
    native_pem: CapabilityOutcomeSchema,
    managed_certificate: CapabilityOutcomeSchema,
    spiffe_workload_api: CapabilityOutcomeSchema,
    browser_managed_external: CapabilityOutcomeSchema,
    /** Only the `unsupported` variant is representable (BROWSER-BOUNDARY). */
    browser_vault_key_injection: UnsupportedOutcomeSchema,
    client_presents_certificate: z.boolean(),
    server_enforces_certificate: z.boolean(),
  })
  .strict();

interface PeerEvidenceViewWireInput {
  source: z.input<typeof EvidenceSourceSchema>;
  identities: z.input<typeof PeerIdentitySelectorSchema>[];
  leaf_thumbprint_sha256: string;
  not_before: string;
  not_after: string;
  trust_profile: z.input<typeof TrustProfileRefSchema>;
  trust_generation: number;
  credential_generation: number;
  listener: string;
  policy: z.input<typeof TransportPolicySchema>;
  tls_version: z.input<typeof TlsVersionSchema>;
  authenticated_at: string;
  usable_until: string;
  ingress?: PeerEvidenceViewWireInput | null | undefined;
}

interface PeerEvidenceViewWireOutput {
  source: z.output<typeof EvidenceSourceSchema>;
  identities: z.output<typeof PeerIdentitySelectorSchema>[];
  leaf_thumbprint_sha256: string;
  not_before: string;
  not_after: string;
  trust_profile: z.output<typeof TrustProfileRefSchema>;
  trust_generation: number;
  credential_generation: number;
  listener: string;
  policy: z.output<typeof TransportPolicySchema>;
  tls_version: z.output<typeof TlsVersionSchema>;
  authenticated_at: string;
  usable_until: string;
  ingress: PeerEvidenceViewWireOutput | null;
}

/** Audit-safe view of verified evidence. A view decodes; it never becomes evidence. */
export const PeerEvidenceViewSchema: z.ZodType<
  PeerEvidenceViewWireOutput,
  z.ZodTypeDef,
  PeerEvidenceViewWireInput
> = z.lazy(() =>
  z
    .object({
      source: EvidenceSourceSchema,
      identities: z.array(PeerIdentitySelectorSchema),
      leaf_thumbprint_sha256: ThumbprintSchema,
      not_before: TransportTimestampSchema,
      not_after: TransportTimestampSchema,
      trust_profile: TrustProfileRefSchema,
      trust_generation: GenerationSchema,
      credential_generation: GenerationSchema,
      listener: TransportIdSchema,
      policy: TransportPolicySchema,
      tls_version: TlsVersionSchema,
      authenticated_at: TransportTimestampSchema,
      usable_until: TransportTimestampSchema,
      ingress: PeerEvidenceViewSchema.nullable()
        .optional()
        .transform((value) => value ?? null),
    })
    .strict(),
);

export const CredentialStatusSchema = z.union([
  z.literal("unconfigured"),
  z
    .object({
      configured: z
        .object({
          custody: CustodySchema,
          generation: GenerationSchema,
          not_after: TransportTimestampSchema,
          kind: IdentitySourceKindSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({ expired: z.object({ generation: GenerationSchema }).strict() })
    .strict(),
  z
    .object({ revoked: z.object({ generation: GenerationSchema }).strict() })
    .strict(),
  z.literal("external_provisioning_required"),
  z.literal("unsupported_in_browser"),
]);

export const RuntimeStatusSchema = z.union([
  z.literal("not_loaded"),
  z
    .object({
      loaded: z
        .object({
          generation: GenerationSchema,
          loaded_at: TransportTimestampSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      reload_failed: z
        .object({
          generation: GenerationSchema,
          code: TransportErrorCodeSchema,
        })
        .strict(),
    })
    .strict(),
]);

export const ObservedAuthenticationSchema = z
  .object({
    at: TransportTimestampSchema,
    observer: TransportIdSchema,
    target: TransportIdSchema,
    generation: GenerationSchema,
    peer: PeerEvidenceViewSchema,
  })
  .strict();

export const EnforcementStatusSchema = z.union([
  z.literal("unverified"),
  z
    .object({
      verified: z
        .object({
          at: TransportTimestampSchema,
          target: TransportIdSchema,
          generation: GenerationSchema,
          accepted_with_certificate: z.boolean(),
          rejected_without_certificate: z.boolean(),
          fresh_until: TransportTimestampSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      stale: z
        .object({
          verified_at: TransportTimestampSchema,
          generation: GenerationSchema,
          current_generation: GenerationSchema,
        })
        .strict(),
    })
    .strict(),
]);

/** `GET /api/v1/operator/transport/status` response. */
export const TransportStatusViewSchema = z
  .object({
    target: TransportIdSchema,
    desired: TransportPolicySchema,
    credential: CredentialStatusSchema,
    runtime: RuntimeStatusSchema,
    observed: ObservedAuthenticationSchema.nullable()
      .optional()
      .transform((value) => value ?? null),
    enforcement: EnforcementStatusSchema,
    capabilities: TransportCapabilitiesSchema,
  })
  .strict()
  .superRefine((view, ctx) => {
    if (view.observed !== null && view.observed.target !== view.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observed", "target"],
        message: "observation is about another target",
      });
    }
    if (
      view.enforcement !== "unverified" &&
      "verified" in view.enforcement &&
      view.enforcement.verified.target !== view.target
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enforcement", "target"],
        message: "probe is about another target",
      });
    }
  });

export const TransportErrorViewSchema = z
  .object({
    code: TransportErrorCodeSchema,
    detail: z
      .string()
      .max(1024)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
  })
  .strict();

export type TransportPolicyWire = z.infer<typeof TransportPolicySchema>;
export type PeerIdentitySelectorWire = z.infer<
  typeof PeerIdentitySelectorSchema
>;
export type BindingScopeWire = z.infer<typeof BindingScopeSchema>;
export type ServiceBindingWire = z.infer<typeof ServiceBindingSchema>;
export type ServiceBindingSetWire = z.infer<typeof ServiceBindingSetSchema>;
export type CapabilityOutcomeWire = z.infer<typeof CapabilityOutcomeSchema>;
export type TransportCapabilitiesWire = z.infer<
  typeof TransportCapabilitiesSchema
>;
export type PeerEvidenceViewWire = z.infer<typeof PeerEvidenceViewSchema>;
export type CredentialStatusWire = z.infer<typeof CredentialStatusSchema>;
export type RuntimeStatusWire = z.infer<typeof RuntimeStatusSchema>;
export type ObservedAuthenticationWire = z.infer<
  typeof ObservedAuthenticationSchema
>;
export type EnforcementStatusWire = z.infer<typeof EnforcementStatusSchema>;
export type TransportStatusViewWire = z.infer<typeof TransportStatusViewSchema>;
export type TransportErrorViewWire = z.infer<typeof TransportErrorViewSchema>;
