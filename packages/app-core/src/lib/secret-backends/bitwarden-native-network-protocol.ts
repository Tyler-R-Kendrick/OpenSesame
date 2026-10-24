import { z } from "zod";
import { zodJitless } from "../zod-jitless.js";

// The network protocol is the dedicated worker entry's first schema owner.
zodJitless();
const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const NativeHeaderPairs = z
  .array(z.tuple([z.string().max(256), z.string().max(16384)]))
  .max(16);
export const NativeFetchRequest = z
  .object({
    type: z.literal("native-fetch"),
    id: Id,
    url: z.string().min(1).max(8192),
    method: z.enum(["GET", "POST", "PUT"]),
    headers: NativeHeaderPairs,
    body: z.string().max(8 * 1024 * 1024),
  })
  .strict();
export type NativeFetchRequest = z.infer<typeof NativeFetchRequest>;
export const NativeFetchCancel = z
  .object({ type: z.literal("native-fetch-cancel"), id: Id })
  .strict();
export type NativeFetchCancel = z.infer<typeof NativeFetchCancel>;
export const NativeFetchReply = z.discriminatedUnion("ok", [
  z
    .object({
      type: z.literal("native-fetch-reply"),
      id: Id,
      ok: z.literal(true),
      status: z.number().int().min(200).max(599),
      statusText: z.string().max(1024),
      headers: NativeHeaderPairs,
      body: z
        .instanceof(Uint8Array)
        .refine((bytes) => bytes.byteLength <= 64 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("native-fetch-reply"),
      id: Id,
      ok: z.literal(false),
    })
    .strict(),
]);
export type NativeFetchReply = z.infer<typeof NativeFetchReply>;
