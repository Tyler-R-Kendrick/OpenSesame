/** Bound a clone, then let the platform consume the original fetch response. */
import type { BoundaryValue } from "@opensesame/os-domain";

export async function nativeResponseJson(
  response: Response,
  options: {
    maxBytes: number;
    signal: AbortSignal;
    fatalUtf8?: boolean;
    empty?: "null";
  },
): Promise<BoundaryValue> {
  options.signal.throwIfAborted();
  const reader = response.clone().body?.getReader();
  const decoder = options.fatalUtf8
    ? new TextDecoder("utf-8", { fatal: true })
    : undefined;
  let size = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= Promise.allSettled([
      reader?.cancel(),
      response.body?.cancel(),
    ]).then(() => undefined);
    return cancellation;
  };
  const abort = () => {
    void cancel();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal.aborted) await cancel();
    if (reader) {
      for (;;) {
        options.signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > options.maxBytes) throw new Error("Response exceeds limit");
        decoder?.decode(part.value, { stream: true });
      }
    }
    decoder?.decode();
    options.signal.throwIfAborted();
    return await originalJson(
      response,
      options.signal,
      size === 0 && options.empty === "null",
    );
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    options.signal.removeEventListener("abort", abort);
    reader?.releaseLock();
  }
}

async function originalJson(
  response: Response,
  signal: AbortSignal,
  emptyAllowed: boolean,
): Promise<BoundaryValue> {
  try {
    const result: BoundaryValue = await response.json();
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (emptyAllowed && error instanceof SyntaxError) return null;
    throw error;
  }
}
