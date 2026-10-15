import { z } from "zod";

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
