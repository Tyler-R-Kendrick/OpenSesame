import { NativeApiError } from "./native-api-http.js";

/**
 * A provider response body as text, refused past `limit` bytes so a provider
 * cannot make this page buffer more than it asked for.
 */
export async function readBoundedText(
  response: Response,
  limit = 256 * 1024,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new NativeApiError("response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new NativeApiError("response");
      chunks.push(next.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
