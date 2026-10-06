import { z } from "zod";
import vectors from "./protocol-vectors.json";
import { provisionSchema } from "./protocol.js";

// Public test data is represented as integer bytes, never as a production pairing secret.
export const publicVectorSchema = z
  .object({
    provision: z.record(z.string(), z.unknown()),
    publicIndependentKeyBytes: z
      .array(z.number().int().min(0).max(255))
      .length(64),
  })
  .passthrough();
type PublicObservationVector = z.infer<typeof publicVectorSchema>;

export function publicVectorProvision(
  input: PublicObservationVector = vectors,
) {
  const vector = publicVectorSchema.parse(input);
  if (Object.hasOwn(vector.provision, "independentKeyMaterialB64")) {
    throw new Error("Public fixture requires explicit numeric key bytes.");
  }
  return provisionSchema.parse({
    ...vector.provision,
    independentKeyMaterialB64: btoa(
      String.fromCharCode(...vector.publicIndependentKeyBytes),
    ),
  });
}
