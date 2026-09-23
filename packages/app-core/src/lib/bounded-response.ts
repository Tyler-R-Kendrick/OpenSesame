import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";

/** Bounded response decoding for optional authority endpoints; no provider body in errors. */
export async function readBoundedObject(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
) {
  if (!response.body) throw new Error("Invalid endpoint response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel();
  }, timeoutMs);
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error("Invalid endpoint response");
      text += decoder.decode(part.value, { stream: true });
    }
    if (expired) throw new Error("Invalid endpoint response");
    const parsed: BoundaryValue = JSON.parse(text + decoder.decode());
    if (!isJsonObject(parsed)) throw new Error("Invalid endpoint response");
    return parsed;
  } catch {
    throw new Error("Invalid endpoint response");
  } finally {
    clearTimeout(timer);
    await reader.cancel();
  }
}
