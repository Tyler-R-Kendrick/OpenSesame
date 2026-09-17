import { z } from "zod";

/**
 * Hierarchical authority wire contract (GA-A-04 / ADR 0120).
 *
 * Field names are snake_case to match Host `crates/domain` Grant serde.
 * The stored record is one shape: `AuthorityGrant` in product code,
 * `AccessLease` only as presentation vocabulary (GA-O-03 / INV-GA-08 naming).
 *
 * Objects are `.strict()` so secret-shaped keys (`access_token`, `password`,
 * …) fail closed at the boundary (INV-GA-02 / ADR 0005).
 */

export const OfflineUseSchema = z.enum([
  "forbidden",
  "read_only",
  "pre_authorized",
]);
export type OfflineUseWire = z.infer<typeof OfflineUseSchema>;

const IsoDateTime = z.string().datetime({ offset: true });

export const AuthorityGrantConstraintsSchema = z
  .object({
    audiences: z.array(z.string().min(1)).max(64),
    not_before: IsoDateTime.nullable(),
    expires_at: IsoDateTime,
    required_assurance: z.string().min(1).nullable(),
    authentication_max_age_seconds: z.number().int().nonnegative().nullable(),
    allowed_networks: z.array(z.string().min(1)).max(64),
    parameter_rules_digest: z.string().min(1).nullable(),
    budgets: z
      .record(z.string().min(1).max(64), z.number().int())
      .refine((budgets) => Object.keys(budgets).length <= 64, {
        message: "budgets exceeds 64 keys",
      }),
    maximum_delegation_depth: z.number().int().nonnegative().max(2),
    offline_use: OfflineUseSchema,
    // Host serde allows true; agent paths must still refuse via INV-GA-02.
    raw_credential_export: z.boolean(),
  })
  .strict();
export type AuthorityGrantConstraintsWire = z.infer<
  typeof AuthorityGrantConstraintsSchema
>;

export const AuthorityGrantSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    issuer_principal_id: z.string().min(1),
    beneficiary_principal_id: z.string().min(1),
    actor_id: z.string().min(1).nullable(),
    client_id: z.string().min(1).nullable(),
    actor_instance_id: z.string().min(1).nullable(),
    proof_key_thumbprint: z.string().min(1).nullable(),
    organization_id: z.string().min(1),
    project_id: z.string().min(1).nullable(),
    environment_id: z.string().min(1).nullable(),
    connection_id: z.string().min(1).nullable(),
    actions: z.array(z.string().min(1)).min(1).max(64),
    resources: z.array(z.string().min(1)).min(1).max(64),
    constraints: AuthorityGrantConstraintsSchema,
    parent_grant_id: z.string().min(1).nullable(),
    delegation_depth: z.number().int().nonnegative().max(2),
    created_at: IsoDateTime,
    revoked_at: IsoDateTime.nullable(),
  })
  .strict();
export type AuthorityGrantWire = z.infer<typeof AuthorityGrantSchema>;

/** Canonical alias — same wire record (GA-A-01 / GA-O-03). */
export const AuthorityRecordSchema = AuthorityGrantSchema;
export type AuthorityRecordWire = AuthorityGrantWire;

/**
 * Presentation-only name for the same wire record. Parsing either label must
 * yield one schema so Grant and AccessLease cannot diverge (INV-GA-08 naming).
 */
export const AccessLeaseSchema = AuthorityGrantSchema;
export type AccessLeaseWire = AuthorityGrantWire;
