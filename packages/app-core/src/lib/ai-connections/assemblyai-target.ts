/** Closed low-level target; no saved family or UI admission is added here. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import type { AiSpeechTarget } from "./speech-target.js";
import { AiConnectionError } from "./types.js";

export type AssemblySpeechTarget = AiSpeechTarget;
const Target = z
  .object({
    providerId: z.enum(["assemblyai", "byo-ai"]),
    baseUrl: z.string().min(1).max(2048),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    authentication: z.literal("api-key"),
    apiKey: z
      .string()
      .max(16384)
      .regex(/^[\x21-\x7e]*$/),
  })
  .strict();

export function validateAssemblySpeechTarget(
  value: AssemblySpeechTarget,
  requireKey = true,
): AssemblySpeechTarget {
  const parsed = Target.safeParse(value);
  if (!parsed.success || (requireKey && !parsed.data.apiKey))
    throw new AiConnectionError(
      "configuration",
      "Choose an AssemblyAI transcription target with its model and API key.",
    );
  const target = parsed.data;
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

export function assemblyTranscriptId(
  value: BoundaryValue,
  target: AssemblySpeechTarget,
): string {
  const id = z.object({ id: z.string() }).safeParse(value);
  const grammar =
    target.providerId === "assemblyai"
      ? /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
      : /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  if (
    !id.success ||
    !grammar.test(id.data.id) ||
    id.data.id.includes(target.apiKey)
  )
    throw new AiConnectionError(
      "response",
      "The transcription service returned an invalid owned job ID.",
    );
  return id.data.id;
}

/** Stopping local work and acknowledging DELETE do not prove processing/billing stopped. */
export class AssemblyTranscriptInterrupted extends AiConnectionError {
  constructor(readonly deletionAcknowledged: boolean) {
    super(
      "response",
      deletionAcknowledged
        ? "Stopped waiting; transcript deletion was acknowledged. Provider processing or charges may continue."
        : "Stopped waiting; remote transcript removal was not confirmed.",
    );
    this.name = "AssemblyTranscriptInterrupted";
  }
}
