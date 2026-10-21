import { AssemblyTranscriptInterrupted } from "@opensesame/app-core/lib/ai-connections/assemblyai-target.js";
import { ReplicatePredictionInterrupted } from "@opensesame/app-core/lib/ai-connections/replicate-types.js";
import type { SecretBackendActionOwner } from "../secret-backends/useSecretBackendAction.js";

/** Retire completed HTTP without turning the generic action's cleanup into a fetch abort. */
export async function runAiWork(
  owner: SecretBackendActionOwner,
  prediction: { current: AbortController | null },
  work: (
    owner: SecretBackendActionOwner,
    signal: AbortSignal,
  ) => Promise<string | undefined>,
) {
  owner.check();
  const http = new AbortController();
  const withdraw = () => http.abort(owner.signal.reason);
  owner.signal.addEventListener("abort", withdraw, { once: true });
  if (owner.signal.aborted) withdraw();
  const original: SecretBackendActionOwner = {
    signal: http.signal,
    current: owner.current,
    check: owner.check,
  };
  const controller = new AbortController();
  prediction.current = controller;
  try {
    let result: string | undefined;
    try {
      result = await work(original, controller.signal);
    } catch (error) {
      if (
        (error instanceof ReplicatePredictionInterrupted &&
          error.cancellationRequested) ||
        (error instanceof AssemblyTranscriptInterrupted &&
          error.deletionAcknowledged)
      ) {
        owner.check();
        result = error.message;
      } else throw error;
    }
    // Work has awaited its actual body/protocol EOF. Logical authority stays original.
    owner.check();
    http.signal.throwIfAborted();
    return result;
  } catch (error) {
    http.abort(error);
    throw error;
  } finally {
    owner.signal.removeEventListener("abort", withdraw);
    if (prediction.current === controller) prediction.current = null;
  }
}
