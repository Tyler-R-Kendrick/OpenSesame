import { z } from "zod";

const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Text = z.string().max(524288);
export const NativeWorkerItemInput = z
  .object({
    name: z.string().min(1).max(4096),
    notes: Text,
    secret: Text,
    kind: z.enum(["note", "login", "secret"]).optional(),
    username: z.string().max(4096).optional(),
    url: z.string().max(8192).optional(),
    fields: z.record(z.string().max(256), z.string().max(65536)).optional(),
  })
  .strict();
export const NativeWorkerSettings = z
  .object({
    providerId: z.string().min(1).max(128),
    name: z.string().max(256),
    baseUrl: z.string().max(8192),
    identityUrl: z.string().max(8192),
    clientId: z.string().max(4096),
    clientSecret: z.string().max(4096),
    accountEmail: z.string().min(1).max(4096),
    masterPassword: z.string().min(1).max(4096),
    deviceIdentifier: z.string().uuid(),
    vaultId: z.string().max(128),
  })
  .strict();
export type NativeWorkerSettings = z.infer<typeof NativeWorkerSettings>;
export const NativeWorkerRequest = z.discriminatedUnion("type", [
  z
    .object({
      id: Id,
      type: z.literal("initialize"),
      settings: NativeWorkerSettings,
    })
    .strict(),
  z.object({ id: Id, type: z.literal("list") }).strict(),
  z
    .object({
      id: Id,
      type: z.literal("get"),
      selector: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      id: Id,
      type: z.literal("notes"),
      selector: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({ id: Id, type: z.literal("create"), item: NativeWorkerItemInput })
    .strict(),
  z
    .object({
      id: Id,
      type: z.literal("update"),
      itemId: z.string().uuid(),
      item: NativeWorkerItemInput,
    })
    .strict(),
  z
    .object({ id: Id, type: z.literal("delete"), itemId: z.string().uuid() })
    .strict(),
  z.object({ id: Id, type: z.literal("dispose") }).strict(),
]);
export type NativeWorkerRequest = z.infer<typeof NativeWorkerRequest>;
const Summary = z
  .object({
    id: z.string().uuid(),
    name: z.string().max(4096),
    kind: z.enum(["note", "login", "secret"]),
  })
  .strict();
export const NativeWorkerValue = z.union([
  Summary.extend({
    notes: Text,
    secret: Text,
    username: z.string().max(4096).optional(),
    url: z.string().max(8192).optional(),
    fields: z.record(z.string().max(256), z.string().max(65536)).optional(),
  }).strict(),
  z.array(Summary).max(50000),
  Text,
  z.null(),
]);
export type NativeWorkerValue = z.infer<typeof NativeWorkerValue>;
export const NativeWorkerErrorCode = z.enum([
  "configuration",
  "authentication",
  "network",
  "response",
  "not-found",
  "ambiguous",
  "unsupported",
  "locked",
  "stale",
]);
export const NativeWorkerReply = z.discriminatedUnion("ok", [
  z.object({ id: Id, ok: z.literal(true), value: NativeWorkerValue }).strict(),
  z
    .object({
      id: Id,
      ok: z.literal(false),
      code: NativeWorkerErrorCode,
      message: z.string().min(1).max(512),
    })
    .strict(),
]);
export type NativeWorkerReply = z.infer<typeof NativeWorkerReply>;

export const NativeWorkerClosed = z
  .object({ type: z.literal("native-worker-closed") })
  .strict();
