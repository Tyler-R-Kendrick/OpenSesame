import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { z } from "zod";
import artifacts from "./onepassword-artifacts.json" with { type: "json" };

export const ONEPASSWORD_HTTP_MAX_BYTES = 4 * 1024 * 1024;
export const ONEPASSWORD_HTTP_MAX_PENDING = 32;
export const ONEPASSWORD_HTTP_SESSION_REQUESTS = 1024;
const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Bytes = z
  .instanceof(Uint8Array)
  .refine((bytes) => bytes.byteLength <= ONEPASSWORD_HTTP_MAX_BYTES);
const Headers = z
  .array(z.tuple([z.string().min(1).max(256), z.string().max(16_384)]))
  .max(128)
  .refine(
    (pairs) =>
      pairs.reduce((size, pair) => size + pair.join("").length, 0) <= 65_536,
  );
const Url = z.string().url().max(8192);

export const OnePasswordFetchRequestSchema = z.strictObject({
  type: z.literal("fetch"),
  id: Id,
  url: Url,
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  headers: Headers,
  body: Bytes,
});
export const OnePasswordFetchCancelSchema = z.strictObject({
  type: z.literal("fetch-cancel"),
  id: Id,
});
export const OnePasswordFetchMessageSchema = z.discriminatedUnion("type", [
  OnePasswordFetchRequestSchema,
  OnePasswordFetchCancelSchema,
]);
export const OnePasswordFetchResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    type: z.literal("fetch-result"),
    id: Id,
    ok: z.literal(true),
    status: z.number().int().min(200).max(599),
    statusText: z.string().max(1024),
    url: Url,
    headers: Headers,
    body: Bytes,
  }),
  z.strictObject({
    type: z.literal("fetch-result"),
    id: Id,
    ok: z.literal(false),
  }),
]);
export type OnePasswordFetchRequest = z.infer<
  typeof OnePasswordFetchRequestSchema
>;
export type OnePasswordFetchMessage = z.infer<
  typeof OnePasswordFetchMessageSchema
>;
export type OnePasswordFetchResult = z.infer<
  typeof OnePasswordFetchResultSchema
>;

type JsonPart = { value: BoundaryValue; depth: number };
function appendChildren(
  entry: BoundaryValue,
  pending: JsonPart[],
  depth: number,
  nodes: number,
): boolean {
  const append = (value: BoundaryValue) => {
    if (pending.length + nodes >= 20_000) return false;
    pending.push({ value, depth });
    return true;
  };
  if (Array.isArray(entry)) {
    for (const child of entry) if (!append(child)) return false;
  } else if (
    isJsonObject(entry) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(entry))
  ) {
    for (const key in entry) {
      if (!Object.hasOwn(entry, key)) continue;
      if (key.length > 1024 || !append(entry[key])) return false;
    }
  } else return false;
  return true;
}
function boundedJson(value: BoundaryValue): value is JsonValue {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const part = pending.pop();
    if (!part || ++nodes > 20_000 || part.depth > 20) return false;
    const entry = part.value;
    if (entry === null || isBoolean(entry)) continue;
    if (isNumber(entry)) {
      if (!Number.isFinite(entry)) return false;
      continue;
    }
    if (isString(entry)) {
      if (entry.length > ONEPASSWORD_HTTP_MAX_BYTES) return false;
      continue;
    }
    if (!appendChildren(entry, pending, part.depth + 1, nodes)) return false;
  }
  return (
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    ONEPASSWORD_HTTP_MAX_BYTES
  );
}
const Json = z.custom<JsonValue>((value) => boundedJson(overlapCast(value)));
const NativeObject = z
  .custom<JsonObject>((value) => {
    const candidate: BoundaryValue = overlapCast(value);
    return isJsonObject(candidate) && boundedJson(candidate);
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 1024 * 1024,
  );
const NativeId = z.string().min(1).max(1024);

/** Host-owned pinned assets, never an editable connection/script URL. */
export const OnePasswordAssetsSchema = z
  .strictObject({
    origin: Url,
    runtimeUrl: Url,
    wasmUrl: Url,
  })
  .refine((assets) => {
    const runtime = new URL(assets.runtimeUrl);
    const wasm = new URL(assets.wasmUrl);
    return (
      new URL(assets.origin).origin === assets.origin &&
      ["https:", "http:"].includes(runtime.protocol) &&
      runtime.origin === assets.origin &&
      wasm.origin === assets.origin &&
      !runtime.username &&
      !runtime.password &&
      !runtime.search &&
      !runtime.hash &&
      !wasm.username &&
      !wasm.password &&
      !wasm.search &&
      !wasm.hash &&
      runtime.pathname.endsWith(`/${artifacts.assets.runtime}`) &&
      new URL(artifacts.assets.wasm.split("/").at(-1) ?? "", runtime).href ===
        assets.wasmUrl
    );
  })
  .readonly();
export const OnePasswordSettingsSchema = z.strictObject({
  serviceAccountToken: z.string().min(1).max(16_384),
  accountOrigin: Url,
  vaultId: NativeId,
});
export const OnePasswordCommandSchema = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("VaultsList") }),
  z.strictObject({ name: z.literal("ItemsList") }),
  z.strictObject({ name: z.literal("ItemsGet"), itemId: NativeId }),
  z.strictObject({ name: z.literal("ItemsCreate"), params: NativeObject }),
  z.strictObject({ name: z.literal("ItemsPut"), item: NativeObject }),
  z.strictObject({ name: z.literal("ItemsDelete"), itemId: NativeId }),
]);
export const OnePasswordWorkerRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("initialize"),
    id: Id,
    assets: OnePasswordAssetsSchema,
    settings: OnePasswordSettingsSchema,
  }),
  z.strictObject({
    type: z.literal("invoke"),
    id: Id,
    command: OnePasswordCommandSchema,
  }),
  z.strictObject({ type: z.literal("dispose"), id: Id }),
]);
const FailureCode = z.enum(["operation", "protocol", "session"]);
export const OnePasswordWorkerReplySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("initialized"), id: Id }),
  z.strictObject({ type: z.literal("result"), id: Id, result: Json }),
  z.strictObject({ type: z.literal("disposed"), id: Id }),
  z.strictObject({ type: z.literal("failed"), id: Id, code: FailureCode }),
  z.strictObject({ type: z.literal("closed"), code: FailureCode }),
]);
export type OnePasswordAssets = Readonly<
  z.infer<typeof OnePasswordAssetsSchema>
>;
export type OnePasswordSettings = z.infer<typeof OnePasswordSettingsSchema>;
export type OnePasswordCommand = z.infer<typeof OnePasswordCommandSchema>;
export type OnePasswordWorkerRequest = z.infer<
  typeof OnePasswordWorkerRequestSchema
>;
export type OnePasswordWorkerReply = z.infer<
  typeof OnePasswordWorkerReplySchema
>;

export function parseOnePasswordResult(text: string): JsonValue {
  if (new TextEncoder().encode(text).byteLength > ONEPASSWORD_HTTP_MAX_BYTES)
    throw onePasswordNetworkError();
  const value: BoundaryValue = JSON.parse(text);
  return Json.parse(value);
}

export function onePasswordNetworkError(): Error {
  return new Error(
    "The 1Password network request failed or its session ended.",
  );
}

/** Bound both sides of the wire without decoding SDK protocol bytes as text. */
export async function readOnePasswordBytes(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<Uint8Array> {
  const check = () => {
    signal.throwIfAborted();
    assertCurrent();
  };
  const reader = body?.getReader();
  const cancel = () => {
    void reader?.cancel().catch(onePasswordNetworkError);
  };
  const chunks: Uint8Array[] = [];
  let length = 0;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    check();
    if (!reader) return new Uint8Array();
    for (;;) {
      const part = await reader.read();
      check();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > ONEPASSWORD_HTTP_MAX_BYTES) throw onePasswordNetworkError();
      chunks.push(part.value.slice());
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch {
    cancel();
    throw onePasswordNetworkError();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader?.releaseLock();
  }
}
