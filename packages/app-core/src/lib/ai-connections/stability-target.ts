/** Official synchronous SD3 REST target; this alone does not activate a saved family. */
import { z } from "zod";
import type { HostedModelInput } from "../hosted-model-protocol.js";
import { aiConnectionBase } from "./configuration.js";
import type { AiConnectionDraft } from "./types.js";
import { AiConnectionError } from "./types.js";
export type StabilityAiTarget = Pick<
  AiConnectionDraft,
  "providerId" | "baseUrl" | "model" | "authentication" | "apiKey"
>;
export const STABILITY_SD3_BASE =
  "https://api.stability.ai/v2beta/stable-image";
export const STABILITY_SD3_MODEL = "sd3.5-medium";
const Target = z
  .object({
    providerId: z.enum(["stability", "byo-ai"]),
    baseUrl: z.string().min(1).max(2048),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/),
    authentication: z.literal("api-key"),
    apiKey: z
      .string()
      .min(1)
      .max(16384)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict();
export function validateStabilityTarget(
  target: StabilityAiTarget,
): StabilityAiTarget {
  const parsed = Target.safeParse(target);
  if (!parsed.success)
    throw new AiConnectionError(
      "configuration",
      "Choose a Stability SD3 endpoint, saved model and API key.",
    );
  const valid = parsed.data;
  const base = aiConnectionBase(valid.baseUrl);
  if (
    valid.providerId === "stability" &&
    (base.href !== aiConnectionBase(STABILITY_SD3_BASE).href ||
      !["sd3.5-medium", "sd3.5-large", "sd3.5-large-turbo"].includes(
        valid.model,
      ))
  )
    throw new AiConnectionError(
      "configuration",
      "Choose a documented Stability SD3 model and endpoint.",
    );
  if (
    [valid.baseUrl, valid.model].some((field) => field.includes(valid.apiKey))
  )
    throw new AiConnectionError(
      "configuration",
      "Keep the image API key out of public fields.",
    );
  return valid;
}
export function stabilityPrompt(
  input: HostedModelInput,
  target: StabilityAiTarget,
) {
  const parsed = z
    .object({
      model: z.literal(target.model),
      messages: z.tuple([
        z
          .object({
            role: z.literal("user"),
            content: z.string().trim().min(1).max(8192),
          })
          .strict(),
      ]),
    })
    .strict()
    .safeParse(input);
  if (
    !parsed.success ||
    new TextEncoder().encode(parsed.data.messages[0].content).length > 32768 ||
    parsed.data.messages[0].content.includes(target.apiKey)
  )
    throw new AiConnectionError(
      "configuration",
      "Enter one image prompt for the saved model without chat, audio, streaming or token parameters.",
    );
  return parsed.data.messages[0].content;
}
