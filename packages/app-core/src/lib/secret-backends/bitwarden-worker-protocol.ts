import { z } from "zod";
import { zodJitless } from "../zod-jitless.js";

// This codec constructs the dedicated worker's first schemas, before its entry runs.
zodJitless();

const Id = z.string().uuid();
const SecretBody = z
  .object({
    organizationId: Id,
    key: z.string().min(1).max(500),
    value: z.string().min(1).max(25_000),
    note: z.string().max(7_000),
    projectIds: z.array(Id).max(64),
  })
  .strict();
export const BitwardenCommandSchema = z.union([
  z
    .object({
      accessTokenLogin: z
        .object({ accessToken: z.string().max(16_384) })
        .strict(),
    })
    .strict(),
  z
    .object({
      secrets: z.union([
        z.object({ get: z.object({ id: Id }).strict() }).strict(),
        z.object({ list: z.object({ organizationId: Id }).strict() }).strict(),
        z.object({ create: SecretBody }).strict(),
        z.object({ update: SecretBody.extend({ id: Id }).strict() }).strict(),
        z
          .object({
            delete: z.object({ ids: z.array(Id).min(1).max(100) }).strict(),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
export const BitwardenWorkerRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: z.number().int(),
      type: z.literal("initialize"),
      settings: z
        .object({
          apiUrl: z.string().max(2048),
          identityUrl: z.string().max(2048),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.number().int(),
      type: z.literal("command"),
      command: z.string().max(524_288),
    })
    .strict(),
  z.object({ id: z.number().int(), type: z.literal("free") }).strict(),
]);
export type BitwardenWorkerRequest = z.infer<
  typeof BitwardenWorkerRequestSchema
>;
export const BitwardenWorkerResultSchema = z.string().max(4 * 1024 * 1024);
export const BitwardenWorkerReplySchema = z.object({
  id: z.number().int(),
  ok: z.boolean(),
  result: BitwardenWorkerResultSchema,
});
const HeaderPairs = z
  .array(z.tuple([z.string().max(256), z.string().max(65_536)]))
  .max(128);
export const BitwardenFetchRequestSchema = z
  .object({
    type: z.literal("fetch"),
    id: z.number().int(),
    url: z.string().max(8192),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]),
    headers: HeaderPairs,
    body: z.string().max(4 * 1024 * 1024),
  })
  .strict();
export type BitwardenFetchRequest = z.infer<typeof BitwardenFetchRequestSchema>;
export const BitwardenFetchResultSchema = z
  .object({
    type: z.literal("fetch-result"),
    id: z.number().int(),
    ok: z.boolean(),
    status: z.number().int(),
    statusText: z.string().max(1024),
    url: z.string().max(8192),
    headers: HeaderPairs,
    body: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.byteLength <= 4 * 1024 * 1024),
  })
  .strict();
export type BitwardenFetchResult = z.infer<typeof BitwardenFetchResultSchema>;
