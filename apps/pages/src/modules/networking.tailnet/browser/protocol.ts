import { z } from "zod";
const OperationID = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Header = z.tuple([z.string().max(32768), z.string().max(32768)]);
function headerBudget(values: [string, string][]) {
  const encoder = new TextEncoder();
  return (
    values.reduce(
      (size, pair) =>
        size + encoder.encode(pair[0]).length + encoder.encode(pair[1]).length,
      0,
    ) <= 32768
  );
}
const Headers = z.array(Header).max(64).refine(headerBudget);
export const NativeHTTPRequest = z
  .object({
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string().url().max(8192),
    headers: Headers.refine((values) => values.length < 64),
    body: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength <= 1_048_576),
  })
  .strict();
export const NativeHTTPResponse = z
  .object({
    status: z.number().int().min(200).max(599),
    statusText: z.string().max(32768),
    url: z.string().url().max(8192),
    headers: Headers,
    body: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength <= 4_194_304),
  })
  .strict();
const nativeTargets = z
  .array(
    z
      .object({
        origin: z.string().url().max(2048),
        prefixes: z.array(z.string().min(1).max(64)).min(1).max(16),
      })
      .strict(),
  )
  .min(1)
  .max(16);
export const NativeHTTPConfiguration = z.union([
  z
    .object({
      exitNodeID: z.string().min(1).max(256),
      trustMode: z.literal("public"),
      targets: nativeTargets,
    })
    .strict(),
  z
    .object({
      exitNodeID: z.string().min(1).max(256),
      trustMode: z.literal("operator").default("operator"),
      operatorCAPEM: z.string().min(1).max(65536),
      targets: nativeTargets,
    })
    .strict(),
]);
export type NativeRequest = z.infer<typeof NativeHTTPRequest>;
export type NativeResponse = z.infer<typeof NativeHTTPResponse>;
export type NativeConfiguration = z.infer<typeof NativeHTTPConfiguration>;
export const Configuration = z.object({
  hostname: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  controlURL: z.string().url(),
  authKey: z.string().max(16384),
  state: z.record(z.string(), z.string().max(1_000_000)),
  assets: z.object({
    runtime: z.string().url(),
    wasm: z.string().url(),
    nativeHTTP: z.string().url().optional(),
  }),
  nativeHTTP: NativeHTTPConfiguration.optional(),
});
export const WorkerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("nativeHTTPReady") }),
  z.object({
    kind: z.literal("nativeHTTP"),
    id: OperationID,
    request: NativeHTTPRequest,
  }),
  z.object({ kind: z.literal("cancelHTTP"), id: OperationID }),
  z.object({ kind: z.literal("closeHTTP") }),
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
  z.object({ kind: z.literal("nativeHTTPReady"), ready: z.boolean() }),
  z.object({ kind: z.literal("closeHTTP"), closed: z.boolean() }),
  z.object({
    kind: z.literal("nativeHTTP"),
    id: OperationID,
    result: NativeHTTPResponse,
  }),
  z.object({ kind: z.literal("nativeHTTPError"), id: OperationID }),
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

export type HostEvent = z.infer<typeof HostMessage>;
