/** Closed prerecorded Deepgram target; activation and the saved AI family stay separate. */
import { z } from "zod";
import type { AiSpeechTarget } from "./speech-target.js";
import { AiConnectionError } from "./types.js";

export type DeepgramSpeechTarget = AiSpeechTarget;
const Target = z
  .object({
    providerId: z.enum(["deepgram", "byo-ai"]),
    baseUrl: z.string().min(1).max(2048),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    authentication: z.literal("api-key"),
    apiKey: z
      .string()
      .max(16384)
      .regex(/^[\x21-\x7e]*$/),
  })
  .strict();

export function validateDeepgramSpeechTarget(
  value: DeepgramSpeechTarget,
  requireKey = true,
): DeepgramSpeechTarget {
  const result = Target.safeParse(value);
  if (!result.success || (requireKey && !result.data.apiKey))
    throw new AiConnectionError(
      "configuration",
      "Choose a Deepgram transcription target with its model and API key.",
    );
  const target = result.data;
  if (
    target.apiKey &&
    [target.baseUrl, target.model].some((field) =>
      field.includes(target.apiKey),
    )
  )
    throw new AiConnectionError(
      "configuration",
      "Keep the API key out of public transcription fields.",
    );
  return target;
}
