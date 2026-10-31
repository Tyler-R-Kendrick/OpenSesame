import { TailscalePeerHTTPWorkerConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-peer-http.js";
import { TailscaleServerTrustConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
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
export const NativeHTTPStreamHead = NativeHTTPResponse.omit({ body: true });
export const NativeHTTPStreamChunk = z
  .object({
    sequence: OperationID,
    body: z
      .instanceof(Uint8Array)
      .refine(
        (value) =>
          value.buffer instanceof ArrayBuffer && value.byteLength <= 32768,
      ),
    eof: z.boolean(),
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
// Pages uses Zod 3; retain its existing parser and compose the shared Zod 4
// validator through data, returning its clone rather than mixing schema engines.
const PeerHTTPConfiguration = z.unknown().transform((value, context) => {
  const parsed = TailscalePeerHTTPWorkerConfiguration.safeParse(value);
  if (!parsed.success) {
    context.addIssue({
      code: "custom",
      message: "Invalid peer HTTPS configuration.",
    });
    return z.NEVER;
  }
  return parsed.data;
});
export const NativeHTTPConfiguration = z.union([
  PeerHTTPConfiguration,
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
export type NativeStreamHead = z.infer<typeof NativeHTTPStreamHead>;
export type NativeStreamChunk = z.infer<typeof NativeHTTPStreamChunk>;
export type NativeConfiguration = z.infer<typeof NativeHTTPConfiguration>;
const PeerTLSConfiguration = z.unknown().transform((value, context) => {
  const parsed = TailscaleServerTrustConfiguration.safeParse(value);
  if (parsed.success) return parsed.data;
  context.addIssue({ code: "custom", message: "Invalid peer TLS trust." });
  return z.NEVER;
});
export const Configuration = z
  .object({
    ephemeral: z.boolean().default(false),
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
    peerTLS: PeerTLSConfiguration.optional(),
  })
  .refine(
    (config) =>
      !config.ephemeral ||
      (config.authKey === "" && Object.keys(config.state).length === 0),
    {
      message:
        "Memory-only identity enrollment cannot accept stored node state or an auth key.",
    },
  );
/**
 * The Worker's own channel reaches anything holding the Worker object, so it
 * carries `start` alone. Everything else, both ways, rides the one port that
 * `start` transferred, which only the controller and the worker hold.
 */
export const WorkerMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("nativeHTTPReady") }),
  z.object({
    kind: z.literal("nativeHTTP"),
    id: OperationID,
    request: NativeHTTPRequest,
  }),
  z
    .object({
      kind: z.literal("nativeHTTPStream"),
      id: OperationID,
      request: NativeHTTPRequest,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pullHTTP"),
      id: OperationID,
      sequence: OperationID,
    })
    .strict(),
  z.object({ kind: z.literal("cancelHTTP"), id: OperationID }),
  z.object({ kind: z.literal("closeHTTP") }),
  z.object({ kind: z.literal("start"), config: Configuration }),
  z.object({ kind: z.literal("login") }),
  // A peer GET the page's egress policy approved for this exact URL.
  z.object({
    kind: z.literal("get"),
    id: z.number().int(),
    url: z.string().url(),
  }),
  // Names the request it answers; a reply for another URL or method settles nothing.
  z.object({
    kind: z.literal("decision"),
    id: z.number().int(),
    url: z.string().url(),
    method: z.string(),
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
  z
    .object({
      kind: z.literal("nativeHTTPStream"),
      id: OperationID,
      result: NativeHTTPStreamHead,
    })
    .strict(),
  z
    .object({
      kind: z.literal("nativeHTTPChunk"),
      id: OperationID,
      result: NativeHTTPStreamChunk,
    })
    .strict(),
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

export type WorkerCommand = z.infer<typeof WorkerMessage>;
