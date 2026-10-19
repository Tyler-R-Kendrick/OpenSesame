import type { JsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import { type AiConnectionDraft, AiConnectionError } from "./types.js";

/** Operation inputs are not public connection configuration or saved prompts. */
export type ReplicateConnection = Pick<
  AiConnectionDraft,
  "baseUrl" | "model" | "authentication" | "apiKey"
>;
export type ReplicateInput = JsonObject;

export const ReplicatePredictionSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  status: z.enum(["starting", "processing", "succeeded", "failed", "canceled"]),
  output: z.json().optional(),
});
export type ReplicatePrediction = z.infer<typeof ReplicatePredictionSchema>;

export type ReplicateRunOptions = {
  /** User cancellation, separate from the vault/module transport lifetime. */
  signal?: AbortSignal;
  onPrediction?: (prediction: ReplicatePrediction) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export class ReplicatePredictionInterrupted extends AiConnectionError {
  constructor(readonly cancellationRequested: boolean) {
    super(
      "response",
      cancellationRequested
        ? "Prediction cancellation requested."
        : "Stopped waiting; remote cancellation was not confirmed.",
    );
    this.name = "ReplicatePredictionInterrupted";
  }
}

/** Configuration and request construction share the exact model/version grammar. */
export function replicatePredictionTarget(model: string) {
  const version =
    /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*:)?([a-f0-9]{64})$/.exec(
      model,
    );
  if (version) return { path: "predictions", version: version[1] };
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(model))
    return { path: `models/${model}/predictions` };
  throw new AiConnectionError(
    "configuration",
    "Enter a Replicate owner/model, owner/model:version or 64-character version ID.",
  );
}
