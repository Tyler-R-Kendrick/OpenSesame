import { z } from "zod";

const localId = z.string().regex(/^local_[0-9a-f-]{36}$/);
const digest = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scopes = z
  .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/))
  .min(1)
  .max(32)
  .refine(
    (items) => items.includes("openid") && new Set(items).size === items.length,
  );

export const LocalAccessRequestInputSchema = z
  .object({
    applicationId: localId,
    redirectUri: z.string().url().max(2048),
    scopes,
    authorizationDigest: digest.optional(),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .regex(/^[^\p{Cc}\p{Cf}]+$/u),
  })
  .strict();

export const LocalAccessRequestRecordSchema =
  LocalAccessRequestInputSchema.extend({
    id: z.string().uuid(),
    requesterId: localId,
    requesterSessionId: z.string().uuid(),
    organizationId: localId,
    applicationRevision: instant.positive(),
    directoryRevision: instant,
    createdAt: instant,
    expiresAt: instant,
    requestDigest: digest,
    version: instant,
    status: z.enum([
      "pending",
      "approved",
      "denied",
      "consumed",
      "expired",
      "revoked",
    ]),
    decidedAt: instant.optional(),
    consumedAt: instant.optional(),
    codeIssuedAt: instant.optional(),
    approval: z
      .object({
        principalId: localId,
        credentialId: z.string().min(1).max(2048),
        credentialCreatedAt: instant,
        publicKeyB64: z.string().min(1).max(8192),
        authTime: instant,
        decisionDigest: digest,
      })
      .strict()
      .optional(),
  })
    .strict()
    .refine(
      (row) =>
        row.expiresAt - row.createdAt === 300_000 &&
        (!(
          row.status === "approved" ||
          row.status === "consumed" ||
          row.status === "denied"
        ) ||
          (row.approval !== undefined && row.decidedAt !== undefined)) &&
        (row.status !== "consumed" || row.consumedAt !== undefined) &&
        (row.decidedAt === undefined ||
          (row.decidedAt >= row.createdAt && row.decidedAt < row.expiresAt)) &&
        (row.consumedAt === undefined ||
          (row.decidedAt !== undefined &&
            row.consumedAt >= row.decidedAt &&
            row.consumedAt < row.expiresAt)),
    )
    .refine(
      (row) =>
        row.codeIssuedAt === undefined ||
        (row.status === "consumed" &&
          row.authorizationDigest !== undefined &&
          row.consumedAt !== undefined &&
          row.codeIssuedAt >= row.consumedAt &&
          row.codeIssuedAt < row.expiresAt),
    );

export const LocalAccessRequestStoreSchema = z
  .object({
    version: z.literal(1),
    requests: z
      .array(LocalAccessRequestRecordSchema)
      .max(256)
      .refine(
        (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
      ),
  })
  .strict();

export type LocalAccessRequestInput = z.infer<
  typeof LocalAccessRequestInputSchema
>;
export type LocalAccessRequestRecord = z.infer<
  typeof LocalAccessRequestRecordSchema
>;
