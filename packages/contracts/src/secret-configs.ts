import { z } from "zod";

/**
 * Project-config secret store wire contract (ADR 0052 / WP-12).
 * Snake_case Host wire names. `.strict()` rejects credential material.
 *
 * `PUT /api/v1/configs/{id}/secrets` is the ONLY request that carries values;
 * no response schema in this module has a value field.
 */

export const SecretConfigEnvironmentSchema = z.enum([
  "development",
  "staging",
  "production",
  "custom",
]);
export type SecretConfigEnvironment = z.infer<
  typeof SecretConfigEnvironmentSchema
>;

export const SecretConfigViewSchema = z
  .object({
    id: z.string().min(1),
    organization_id: z.string().min(1),
    project_id: z.string().min(1),
    slug: z.string().min(1),
    display_name: z.string(),
    environment: SecretConfigEnvironmentSchema,
    parent_config_id: z.string().min(1).nullable().optional(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type SecretConfigView = z.infer<typeof SecretConfigViewSchema>;

export const ListSecretConfigsResponseSchema = z
  .object({
    configs: z.array(SecretConfigViewSchema),
  })
  .strict();
export type ListSecretConfigsResponse = z.infer<
  typeof ListSecretConfigsResponseSchema
>;

export const CreateSecretConfigBodySchema = z
  .object({
    slug: z.string().min(1).max(64),
    display_name: z.string().min(1).max(256).optional(),
    environment: SecretConfigEnvironmentSchema,
    parent_config_id: z.string().min(1).optional(),
  })
  .strict();
export type CreateSecretConfigBody = z.infer<
  typeof CreateSecretConfigBodySchema
>;

/**
 * The one value-accepting request shape on this plane (write-only intake).
 * Values are allowed here and nowhere else.
 */
export const PutConfigSecretsBodySchema = z
  .object({
    secrets: z.record(z.string().min(1).max(256), z.string()),
  })
  .strict();
export type PutConfigSecretsBody = z.infer<typeof PutConfigSecretsBodySchema>;

/** Key metadata — names and versions only, never values. */
export const ConfigKeyMetaSchema = z
  .object({
    key_name: z.string().min(1),
    version: z.number().int().nonnegative(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type ConfigKeyMeta = z.infer<typeof ConfigKeyMetaSchema>;

export const ConfigKeysResponseSchema = z
  .object({
    keys: z.array(ConfigKeyMetaSchema),
  })
  .strict();
export type ConfigKeysResponse = z.infer<typeof ConfigKeysResponseSchema>;

export const ConfigSecretVersionSchema = z
  .object({
    version: z.number().int().nonnegative(),
    deleted: z.boolean(),
    actor_id: z.string().nullable(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type ConfigSecretVersion = z.infer<typeof ConfigSecretVersionSchema>;

export const ListConfigSecretVersionsResponseSchema = z
  .object({
    versions: z.array(ConfigSecretVersionSchema),
  })
  .strict();
export type ListConfigSecretVersionsResponse = z.infer<
  typeof ListConfigSecretVersionsResponseSchema
>;

export const RollbackConfigSecretBodySchema = z
  .object({
    to_version: z.number().int().positive(),
  })
  .strict();
export type RollbackConfigSecretBody = z.infer<
  typeof RollbackConfigSecretBodySchema
>;

export const RollbackConfigSecretResponseSchema = z
  .object({
    key_name: z.string().min(1),
    version: z.number().int().nonnegative(),
  })
  .strict();
export type RollbackConfigSecretResponse = z.infer<
  typeof RollbackConfigSecretResponseSchema
>;

/** Compare is presence + versions only by design — never values. */
export const ConfigCompareEntrySchema = z
  .object({
    key_name: z.string().min(1),
    a_version: z.number().int().nonnegative(),
    b_version: z.number().int().nonnegative(),
  })
  .strict();
export type ConfigCompareEntry = z.infer<typeof ConfigCompareEntrySchema>;

export const CompareConfigsResponseSchema = z
  .object({
    only_in_a: z.array(z.string()),
    only_in_b: z.array(z.string()),
    in_both: z.array(ConfigCompareEntrySchema),
  })
  .strict();
export type CompareConfigsResponse = z.infer<
  typeof CompareConfigsResponseSchema
>;

export const BranchConfigBodySchema = z
  .object({
    slug: z.string().min(1).max(64),
    display_name: z.string().min(1).max(256).optional(),
  })
  .strict();
export type BranchConfigBody = z.infer<typeof BranchConfigBodySchema>;
