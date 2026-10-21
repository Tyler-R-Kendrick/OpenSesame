import type { HostedModelRuntime } from "../hosted-inference.js";
import type { AiImageOutput } from "./image-output.js";
import { OwnedAiImage } from "./owned-image.js";
import { inferStabilityAi } from "./stability-inference.js";
import { validateAiStabilityConnection } from "./stability-target.js";
import { AiConnectionError } from "./types.js";

type ImageAuthority = Pick<HostedModelRuntime, "signal" | "assertCurrent">;

/** The view keeps its own original context; the action owns only this request. */
export async function performSavedAiImageInference(
  connectionId: string,
  prompt: string,
  view: ImageAuthority,
  action: ImageAuthority,
): Promise<OwnedAiImage> {
  const originalSignal = action.signal;
  const originalCheck = action.assertCurrent;
  const checkAction = () => {
    if (
      action.signal !== originalSignal ||
      action.assertCurrent !== originalCheck
    )
      throw new AiConnectionError("stale", "The image request owner changed.");
    originalSignal.throwIfAborted();
    originalCheck.call(action);
  };
  checkAction();
  // prepare captures the original route/row synchronously before its first await.
  const prepared = await OwnedAiImage.prepare(connectionId, view);
  let image: AiImageOutput | undefined;
  try {
    const check = () => {
      prepared.owner.check();
      checkAction();
    };
    check();
    const result = await inferStabilityAi(
      validateAiStabilityConnection(prepared.draft),
      {
        model: prepared.draft.model,
        messages: [{ role: "user", content: prompt }],
      },
      {
        ...prepared.transport,
        signal: AbortSignal.any([prepared.transport.signal, originalSignal]),
      },
      check,
    );
    image = result.image;
    check();
    return prepared.owner.complete(image);
  } catch (error) {
    image?.release();
    prepared.owner.release();
    throw error;
  }
}
