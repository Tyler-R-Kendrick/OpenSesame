import { z } from "zod";
import { type AiConnectionDraft, AiConnectionError } from "./types.js";

/** Base fields only; this does not activate a picker or another preset catalog. */
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
      .max(16384)
      .regex(/^[\x21-\x7e]*$/),
  })
  .strict();
export function isAiSpeechProvider(providerId: string): boolean {
  return providerId === "elevenlabs" || providerId === "byo-ai";
}
/** Endpoint normalization remains owned by configuration and the finite request builder. */
export function validateAiSpeechTarget(
  value: AiSpeechTarget,
  requireKey = true,
): AiSpeechTarget {
  const parsed = Target.safeParse(value);
  if (!parsed.success || (requireKey && !parsed.data.apiKey))
    throw new AiConnectionError(
      "configuration",
      "Choose a Scribe transcription target with its model and API key.",
    );
  const valid = parsed.data;
  if (
    valid.apiKey &&
    [valid.baseUrl, valid.model].some((field) => field.includes(valid.apiKey))
  )
    throw new AiConnectionError(
      "configuration",
      "Keep the API key out of public transcription fields.",
    );
  return valid;
}
export function validateAiSpeechConnection(
  draft: AiConnectionDraft,
  requireKey = true,
): AiSpeechTarget {
  if (
    draft.family !== "elevenlabs_scribe" ||
    draft.azure ||
    draft.vertex ||
    draft.bedrock
  )
    throw new AiConnectionError(
      "configuration",
      "Choose a single Scribe transcription target without another protocol's credentials.",
    );
  return validateAiSpeechTarget(
    {
      providerId: draft.providerId,
      baseUrl: draft.baseUrl,
      model: draft.model,
      authentication: draft.authentication,
      apiKey: draft.apiKey,
    },
    requireKey,
  );
}
