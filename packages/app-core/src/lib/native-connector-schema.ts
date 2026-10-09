/** Canonical native connection records. Credential material has a separate codec. */
import { z } from "zod";

const identifier = z.string().min(1).max(256);
const text = z.string().max(4096);
const scopes = z.array(z.string().min(1).max(512)).max(256);
const parameters = z.record(identifier, text);
const timestamp = z.number().finite().nonnegative();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const token = z
  .string()
  .min(1)
  .max(32768)
  .regex(/^[!-~]+$/);
function validIcon(value: string): boolean {
  if (value === "") return true;
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    value,
  );
  const body = match?.[2];
  if (!body || body.length % 4 !== 0) return false;
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return (
    (body.length * 3) / 4 - padding <= 2 * 1024 * 1024 &&
    (match?.[1] === "png"
      ? body.startsWith("iVBORw0KGgo")
      : body.startsWith("/9j/"))
  );
}
export const NativeMethodSchema = z.enum([
  "api-key",
  "oauth",
  "mcp",
  "native-local",
]);
export type NativeMethod = z.infer<typeof NativeMethodSchema>;
export const NativeConfigurationSchema = z
  .object({
    version: z.literal(1),
    providerId: identifier,
    method: NativeMethodSchema,
    displayName: z.string().min(1).max(256),
    icon: z
      .string()
      .max(3 * 1024 * 1024)
      .refine(validIcon),
    parameters,
    clientId: identifier.optional(),
    requestedScopes: z.record(identifier, scopes),
    targetIds: parameters,
    fingerprint,
  })
  .strict();
export type NativeConfiguration = z.infer<typeof NativeConfigurationSchema>;

export const NativeIdentitySchema = z
  .object({
    id: identifier,
    label: text,
    kind: identifier,
    assurance: z.enum([
      "credential-valid",
      "account-verified",
      "workspace-verified",
    ]),
  })
  .strict();
export const NativeTargetSchema = z
  .object({ id: identifier, label: text, kind: identifier })
  .strict();
export const NativePublicGrantSchema = z
  .object({
    actor: identifier,
    label: text,
    permissionState: z.enum(["known", "provider-managed", "unknown"]),
    grantedScopes: scopes,
    expiresAt: timestamp.nullable(),
    needsReauth: z.boolean(),
  })
  .strict();
export const NativeRuntimeSchema = z
  .object({
    verifiedAt: timestamp.nullable(),
    identity: NativeIdentitySchema.nullable(),
    targets: z.array(NativeTargetSchema).max(1000),
    grants: z.array(NativePublicGrantSchema).max(32),
  })
  .strict()
  .refine(
    (runtime) =>
      new Set(runtime.grants.map((grant) => grant.actor)).size ===
      runtime.grants.length,
    {
      message: "Duplicate public provider actor",
    },
  );
export type NativeRuntime = z.infer<typeof NativeRuntimeSchema>;
export const emptyNativeRuntime = (): NativeRuntime => ({
  verifiedAt: null,
  identity: null,
  targets: [],
  grants: [],
});

/** Immutable binding retained alongside a token through rotation and cleanup. */
export const NativeBindingSchema = z
  .object({
    providerId: identifier,
    actor: identifier,
    fingerprint,
    targetId: identifier.optional(),
    issuer: text.optional(),
    resource: text.optional(),
    endpoint: text.optional(),
    clientId: identifier.optional(),
  })
  .strict();
export const NativeGrantSchema = NativeBindingSchema.extend({
  kind: NativeMethodSchema,
  accessToken: token,
  refreshToken: token.optional(),
  expiresAt: timestamp.nullable(),
  scopes: scopes.nullable(),
}).strict();
export type NativeGrant = z.infer<typeof NativeGrantSchema>;
export const NativePendingSchema = NativeBindingSchema.extend({
  state: z.string().min(32).max(512),
  verifier: z.string().min(43).max(128),
  redirectUri: text,
  createdAt: timestamp,
  expiresAt: timestamp,
  scopes,
}).strict();
export type NativePending = z.infer<typeof NativePendingSchema>;
export const NativeRecoverySchema = NativeBindingSchema.extend({
  id: identifier,
  kind: z.enum(["revoke", "subscription", "registration", "configure"]),
  targetId: identifier,
  grant: NativeGrantSchema.optional(),
  credentials: z.record(identifier, z.string().max(32768)).optional(),
}).strict();
export type NativeRecovery = z.infer<typeof NativeRecoverySchema>;
export const NativePrivateSchema = z
  .object({
    credentials: z.record(identifier, z.string().max(32768)),
    grants: z.record(identifier, NativeGrantSchema),
    pending: z.record(identifier, NativePendingSchema),
    recovery: z.array(NativeRecoverySchema).max(64),
    verification: z
      .object({
        fingerprint,
        verifiedAt: timestamp,
        kind: z.enum(["provider", "browser-local", "configuration"]),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (state) => Object.keys(state.credentials).length <= 128,
    "Too many credential slots",
  )
  .refine(
    (state) => Object.keys(state.grants).length <= 32,
    "Too many actor grants",
  )
  .refine(
    (state) => Object.keys(state.pending).length <= 32,
    "Too many pending authorizations",
  )
  .refine(
    (state) =>
      new Set(state.recovery.map((entry) => entry.id)).size ===
      state.recovery.length,
    "Duplicate provider cleanup obligation",
  );
export type NativePrivateState = z.infer<typeof NativePrivateSchema>;
export const emptyNativePrivate = (): NativePrivateState => ({
  credentials: {},
  grants: {},
  pending: {},
  recovery: [],
  verification: null,
});
export interface NativeFieldClassification {
  publicParameters: readonly string[];
  privateCredentials: readonly string[];
}
export const NativeSealedSchema = z
  .object({
    privateState: NativePrivateSchema,
    classification: z
      .object({
        publicParameters: z.array(identifier).max(128),
        privateCredentials: z.array(identifier).max(128),
      })
      .strict(),
  })
  .strict();

/** Unknown fields are refused; profile credential names cannot become public. */
export function validateNativeConfiguration(
  input: NativeConfiguration,
  classification: NativeFieldClassification,
): NativeConfiguration {
  const configuration = NativeConfigurationSchema.parse(input);
  for (const key of Object.keys(configuration.parameters)) {
    if (
      !classification.publicParameters.includes(key) ||
      classification.privateCredentials.includes(key)
    )
      throw new Error("Connector parameter is not a public provider field");
  }
  if (
    Object.keys(configuration.targetIds).some((key) =>
      classification.privateCredentials.includes(key),
    )
  )
    throw new Error("A credential cannot be a public provider target");
  return configuration;
}
