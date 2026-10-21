/** Finite explicit text-to-image generation through one original captured route. */
import type { HostedModelInput } from "../hosted-model-protocol.js";
import { aiConnectionBase } from "./configuration.js";
import { aiFiniteProtocolAuthority, aiProtocolFetch } from "./http.js";
import type { AiImageOutput } from "./image-output.js";
import { readStabilityImage } from "./stability-response.js";
import {
  type StabilityAiTarget,
  stabilityPrompt,
  validateStabilityTarget,
} from "./stability-target.js";
import { AiConnectionError, type AiConnectionTransport } from "./types.js";
export type StabilityAiResult = {
  providerId: string;
  model: string;
  image: AiImageOutput;
};
export type StabilityAiOptions = { signal?: AbortSignal; timeoutMs?: number };
async function request(target: StabilityAiTarget, prompt: string) {
  const url = new URL("generate/sd3", aiConnectionBase(target.baseUrl));
  const fields = new FormData();
  fields.set("prompt", prompt);
  fields.set("model", target.model);
  fields.set("mode", "text-to-image");
  fields.set("aspect_ratio", "1:1");
  fields.set("output_format", "png");
  // The platform serializes its own multipart boundary; never construct Content-Type.
  const serialized = new Request(url, { method: "POST", body: fields });
  const body = await serialized.arrayBuffer();
  if (body.byteLength > 1024 * 1024)
    throw new AiConnectionError(
      "configuration",
      "The image generation request exceeds the native request bound.",
    );
  const headers = new Headers(serialized.headers);
  headers.set("authorization", `Bearer ${target.apiKey}`);
  headers.set("accept", "application/json");
  return { url, request: { method: "POST" as const, headers, body } };
}
export async function inferStabilityAi(
  target: StabilityAiTarget,
  input: HostedModelInput,
  transport: AiConnectionTransport,
  owner: () => void,
  options: StabilityAiOptions = {},
): Promise<StabilityAiResult> {
  const original = aiFiniteProtocolAuthority(transport, owner);
  const valid = validateStabilityTarget(target);
  const prompt = stabilityPrompt(input, valid);
  const timeout = options.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000)
    throw new AiConnectionError(
      "configuration",
      "Image generation supports at most one 60 second operation.",
    );
  const lifetime = new AbortController();
  const signal = AbortSignal.any([
    transport.signal,
    lifetime.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const expires = Date.now() + timeout;
  const timer = setTimeout(
    () =>
      lifetime.abort(
        new DOMException("Image generation timed out.", "TimeoutError"),
      ),
    timeout,
  );
  const check = () => {
    original();
    if (Date.now() >= expires)
      lifetime.abort(
        new DOMException("Image generation timed out.", "TimeoutError"),
      );
    signal.throwIfAborted();
  };
  const fetch = transport.fetch;
  let response: Response | undefined;
  const port: AiConnectionTransport = {
    signal,
    assertCurrent: check,
    async fetch(url, init) {
      check();
      const reply = await fetch.call(transport, url, init);
      response = reply;
      try {
        check();
        return reply;
      } catch (error) {
        void reply.body?.cancel().catch(() => undefined);
        throw error;
      }
    },
  };
  let image: AiImageOutput | undefined;
  try {
    check();
    const prepared = await request(valid, prompt);
    check();
    response = await aiProtocolFetch(
      valid,
      prepared.url,
      prepared.request,
      port,
      check,
    );
    check();
    image = await readStabilityImage(response, signal, valid.apiKey, check);
    check();
    return { providerId: valid.providerId, model: valid.model, image };
  } catch (error) {
    image?.release();
    throw error;
  } finally {
    clearTimeout(timer);
    if (response && !response.bodyUsed)
      void response.body?.cancel().catch(() => undefined);
  }
}
