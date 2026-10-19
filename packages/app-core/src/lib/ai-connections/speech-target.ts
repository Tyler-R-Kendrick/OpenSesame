import { z } from "zod";
import { aiConnectionBase } from "./configuration.js";
import { type AiConnectionDraft, AiConnectionError } from "./types.js";

/** Base connection fields only; this does not activate a picker or saved family. */
export type AiSpeechTarget = Pick<
  AiConnectionDraft,
  "providerId" | "baseUrl" | "model" | "authentication" | "apiKey"
>;
const Target = z
  .object({
    providerId: z.enum(["elevenlabs", "byo-ai"]),
    baseUrl: z.string().min(1).max(2048),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    authentication: z.literal("api-key"),
    apiKey: z
      .string()
      .min(1)
      .max(16384)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict();
export function validateAiSpeechTarget(value: AiSpeechTarget): AiSpeechTarget {
  const parsed = Target.safeParse(value);
  if (!parsed.success)
    throw new AiConnectionError(
      "configuration",
      "Choose a Scribe transcription target with its model and API key.",
    );
  const valid = parsed.data;
  const base = aiConnectionBase(valid.baseUrl);
  if (
    [valid.baseUrl, valid.model].some((field) => field.includes(valid.apiKey))
  )
    throw new AiConnectionError(
      "configuration",
      "Keep the API key out of public transcription fields.",
    );
  return { ...valid, baseUrl: base.href };
}
