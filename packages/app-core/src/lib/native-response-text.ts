import { nativeResponseBody } from "./native-response-body.js";
import {
  finishNativeResponseBody,
  nativeResponseBodySignal,
} from "./native-response-lifetime.js";

/** Finite native text, bounded before original-platform mirror drain and retirement. */
export async function readNativeResponseText(
  response: Response,
  options: {
    maxBytes: number;
    signal: AbortSignal;
    assertCurrent(): void;
    invalid(): Error;
  },
): Promise<string> {
  const requestSignal = nativeResponseBodySignal(response);
  const signal = requestSignal
    ? AbortSignal.any([options.signal, requestSignal])
    : options.signal;
  const check = () => {
    options.assertCurrent();
    signal.throwIfAborted();
  };
  let body: ReturnType<typeof nativeResponseBody> | undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    check();
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > 4 * 1024 * 1024
    )
      throw options.invalid();
    body = nativeResponseBody(response, check, signal, options.invalid);
    for (;;) {
      const next = await body.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > options.maxBytes) throw options.invalid();
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw options.invalid();
    }
    await body.finish(length);
    check();
    return text;
  } finally {
    try {
      if (body) await body.close();
      else await response.body?.cancel().catch(() => undefined);
    } finally {
      finishNativeResponseBody(response);
    }
  }
}
