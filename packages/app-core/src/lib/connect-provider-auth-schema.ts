/** Provider-owned authentication and verification metadata; entered secrets never belong here. */
import { z } from "zod";

export const ProviderUrlSchema = z.string().refine((value) => {
  try {
    const filled = value.replace(/\{[a-z_]+\}/g, "x");
    if (/[{}]/.test(filled)) return false;
    const url = new URL(filled);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}, "a provider HTTPS URL or template without embedded credentials");
const name = z.string().regex(/^[a-z_]+$/);
const header = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const value = z
  .string()
  .max(16384)
  .regex(/^[^\r\n]*$/);
const scheme = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
  .nullable();
const fieldPath = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/);
export const ProviderTemplateParamSchema = z.object({
  name,
  label: z.string(),
  placeholder: z.string(),
  required: z.boolean().default(true),
  secret: z.boolean().default(false),
  choices: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional(),
});
export const ProviderCredentialFieldSchema = z
  .object({
    name,
    label: z.string().min(1),
    placeholder: z.string(),
    required: z.boolean(),
    secret: z.literal(true),
  })
  .strict();

export const ProviderBasicAuthSchema = z
  .object({ username: value, password: value })
  .strict();
const HeaderAuthSchema = z
  .object({
    kind: z.literal("header"),
    header,
    scheme,
    valueTemplate: value.nullable().default(null),
  })
  .strict();
export const ProviderAuthenticationSchema = z.discriminatedUnion("kind", [
  HeaderAuthSchema,
  z
    .object({ kind: z.literal("basic"), username: value, password: value })
    .strict(),
  z
    .object({
      kind: z.literal("query"),
      parameter: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("path"),
      template: z
        .string()
        .min(1)
        .max(2048)
        .refine((path) => path.startsWith("/") && !/[?#\r\n]/.test(path)),
    })
    .strict(),
]);
export const ProviderVerificationSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    url: ProviderUrlSchema,
    headers: z.record(header, value).default({}),
    body: z.string().max(65536).nullable().default(null),
    accountField: z.string().max(256).nullable(),
    auth: HeaderAuthSchema.nullable().default(null),
    success: z
      .array(
        z
          .object({
            field: fieldPath,
            equals: z.union([
              z.string(),
              z.number().finite(),
              z.boolean(),
              z.null(),
            ]),
          })
          .strict(),
      )
      .default([]),
    requiredFields: z.array(fieldPath).default([]),
    errorFields: z.array(fieldPath).default([]),
  })
  .strict();

export const ProviderCredentialVariantSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1),
    description: z.string().default(""),
    header: header.nullable(),
    scheme,
    basic: ProviderBasicAuthSchema.nullable(),
    auth: ProviderAuthenticationSchema.nullable(),
    verify: ProviderVerificationSchema.nullable(),
    templateParams: z.array(ProviderTemplateParamSchema),
    additionalCredentials: z.array(ProviderCredentialFieldSchema),
  })
  .strict();

export type ProviderAuthentication = z.infer<
  typeof ProviderAuthenticationSchema
>;
export type ProviderVerification = z.infer<typeof ProviderVerificationSchema>;
export type ProviderCredentialField = z.infer<
  typeof ProviderCredentialFieldSchema
>;
export type ProviderCredentialVariant = z.infer<
  typeof ProviderCredentialVariantSchema
>;
