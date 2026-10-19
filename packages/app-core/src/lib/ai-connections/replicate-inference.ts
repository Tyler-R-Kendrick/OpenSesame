/** Model-specific prediction JSON is operation input, never saved configuration. */
import { isString } from "@opensesame/os-domain";
import { z } from "zod";
import type {
  HostedModelInput,
  HostedModelResult,
} from "../hosted-model-protocol.js";
import { runReplicatePrediction } from "./replicate-run.js";
import type { ReplicateInput } from "./replicate-types.js";
import {
  type AiConnectionDraft,
  AiConnectionError,
  type AiConnectionTransport,
} from "./types.js";
const Operation = z
  .object({
    model: z.string().min(1).max(160),
    messages: z.tuple([
      z
        .object({
          role: z.literal("user"),
          content: z.string().min(1).max(32768),
        })
        .strict(),
    ]),
    maxOutputTokens: z.number().int().min(1).max(4096).optional(),
  })
  .strict();
export function replicateOperationInput(
  input: HostedModelInput,
): ReplicateInput {
  try {
    const operation = Operation.parse(input);
    const value = z
      .record(z.string(), z.json())
      .parse(JSON.parse(operation.messages[0].content));
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 32768)
      throw new Error("Input limit");
    return value;
  } catch {
    throw new AiConnectionError(
      "configuration",
      "Enter one model-specific prediction input JSON object of at most 32 KiB.",
    );
  }
}
export async function inferReplicateAi(
  draft: AiConnectionDraft,
  input: HostedModelInput,
  transport: AiConnectionTransport,
  check: () => void,
  onText?: (text: string) => void,
): Promise<HostedModelResult> {
  check();
  transport.assertCurrent();
  transport.signal.throwIfAborted();
  if (
    draft.family !== "replicate_predictions" ||
    !["byo-ai", "replicate"].includes(draft.providerId) ||
    input.model !== draft.model
  )
    throw new AiConnectionError(
      "configuration",
      "Use the saved prediction protocol, endpoint and model.",
    );
  const prediction = await runReplicatePrediction(
    draft,
    replicateOperationInput(input),
    transport,
    check,
  );
  const answer = isString(prediction.output)
    ? prediction.output
    : JSON.stringify(prediction.output, null, 2);
  if (!answer?.trim() || new TextEncoder().encode(answer).byteLength > 32768)
    throw new AiConnectionError(
      "response",
      "The completed prediction did not return bounded output.",
    );
  check();
  transport.assertCurrent();
  transport.signal.throwIfAborted();
  onText?.(answer);
  check();
  return { providerId: draft.providerId, model: draft.model, answer };
}
