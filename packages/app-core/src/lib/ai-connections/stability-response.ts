/** Image-owned JSON ceiling; other AI protocols retain their smaller reader. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { aiResponseBodySignal, finishAiResponseBody } from "./http.js";
import { decodeAiImage } from "./image-output.js";
import { invalidAiImage } from "./image-raster.js";
import { aiStreamBody } from "./stream-body.js";
import { AiConnectionError } from "./types.js";
export const MAX_STABILITY_JSON_BYTES = 4 * 1024 * 1024;
export async function readStabilityJson(
  response: Response,
  signal: AbortSignal,
  check: () => void,
): Promise<BoundaryValue> {
  let body: ReturnType<typeof aiStreamBody> | undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (!response.body)
      throw new AiConnectionError(
        "response",
        "The image service returned no response body.",
      );
    const requestSignal = aiResponseBodySignal(response);
    body = aiStreamBody(
      response,
      check,
      requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
      () =>
        new AiConnectionError(
          "response",
          "The image service returned an incomplete JSON response.",
        ),
    );
    for (;;) {
      check();
      signal.throwIfAborted();
      const next = await body.read();
      check();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_STABILITY_JSON_BYTES)
        throw new AiConnectionError(
          "response",
          "The generated image response exceeds the supported size.",
        );
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let value: BoundaryValue;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new AiConnectionError(
        "response",
        "The image service returned unreadable JSON.",
      );
    }
    await body.finish(length);
    return value;
  } finally {
    try {
      if (body) await body.close();
      else await response.body?.cancel().catch(() => undefined);
    } finally {
      finishAiResponseBody(response);
    }
  }
}
const Reply = z
  .object({
    image: z.string(),
    finish_reason: z.enum(["SUCCESS", "CONTENT_FILTERED"]),
    seed: z.number().int().min(0).max(4294967294).optional(),
  })
  .strict();
export async function readStabilityImage(
  response: Response,
  signal: AbortSignal,
  secret: string,
  check: () => void,
) {
  try {
    if (
      response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json"
    )
      invalidAiImage();
    const value = await readStabilityJson(response, signal, check);
    check();
    const reply = Reply.safeParse(value);
    if (!reply.success || JSON.stringify(value).includes(secret))
      invalidAiImage();
    if (reply.data.finish_reason === "CONTENT_FILTERED")
      throw new AiConnectionError(
        "response",
        "The image service filtered this generation. Change the prompt before trying again.",
      );
    return decodeAiImage(
      reply.data.image,
      "image/png",
      secret,
      reply.data.seed,
    );
  } finally {
    try {
      if (!response.bodyUsed)
        await response.body?.cancel().catch(() => undefined);
    } finally {
      finishAiResponseBody(response);
    }
  }
}
