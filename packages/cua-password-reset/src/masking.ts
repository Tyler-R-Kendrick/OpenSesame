import { modelObservation } from "./decisions.js";
import { type Observation, observationSchema } from "./types.js";

export interface ScreenshotMasker {
  mask(observation: Observation): Promise<string>;
}

const OPAQUE_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export class OpaqueScreenshotMasker implements ScreenshotMasker {
  mask(): Promise<string> {
    return Promise.resolve(OPAQUE_PNG);
  }
}

export async function maskObservation(
  input: Observation,
  masker?: ScreenshotMasker,
): Promise<Observation> {
  const observation = observationSchema.parse(input);
  const maskedScreenshot = observation.screenshot
    ? await masker?.mask(observation)
    : observation.maskedScreenshot;
  if (observation.screenshot && !maskedScreenshot)
    throw new Error("No masked screenshot is available for the model");
  const safe = modelObservation({
    ...observation,
    screenshot: undefined,
    maskedScreenshot,
  });
  const serialized = JSON.stringify(safe);
  for (const canary of observation.sensitiveValues ?? [])
    if (serialized.includes(canary))
      throw new Error("Sensitive value survived observation masking");
  return safe;
}
