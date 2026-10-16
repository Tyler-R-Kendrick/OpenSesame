import { z } from "zod";
export const Configuration = z.object({
  hostname: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  controlURL: z.string().url(),
  authKey: z.string().max(16384),
  state: z.record(z.string(), z.string().max(1_000_000)),
  assets: z.object({ runtime: z.string().url(), wasm: z.string().url() }),
});
export const WorkerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), config: Configuration }),
  z.object({ kind: z.literal("login") }),
  z.object({
    kind: z.literal("get"),
    id: z.number().int(),
    url: z.string().url(),
  }),
  z.object({
    kind: z.literal("decision"),
    id: z.number().int(),
    allowed: z.boolean(),
  }),
]);
export const HostMessage = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("decision"),
    id: z.number().int(),
    url: z.string().url(),
    method: z.string(),
  }),
  z.object({ kind: z.literal("state"), state: z.string() }),
  z.object({
    kind: z.literal("storage"),
    state: z.record(z.string(), z.string().max(1_000_000)),
  }),
  z.object({ kind: z.literal("netmap"), value: z.string().max(4_000_000) }),
  z.object({ kind: z.literal("auth"), url: z.string().url() }),
  z.object({ kind: z.literal("error") }),
  z.object({
    kind: z.literal("get"),
    id: z.number().int(),
    status: z.number().int(),
    text: z.string().max(1_000_000),
  }),
]);
export const NetMap = z.object({
  self: z.object({
    machineStatus: z.string(),
    addresses: z.array(z.string()).max(32),
  }),
  peers: z.array(z.object({})).max(10000),
  lockedOut: z.boolean(),
});
