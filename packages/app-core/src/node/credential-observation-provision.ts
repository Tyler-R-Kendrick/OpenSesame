/** Local pairing material is generated independently, saved privately, and never printed. */
import { z } from "zod";
import { provisionSchema } from "../lib/credential-observation/protocol.js";
import { openPrivateObservationStateFile } from "./credential-observation-files.js";
export type ObservationProvisionCreation = {
  path: string;
  origin: string;
  allowLoopback: boolean;
};
export async function createPrivateObservationProvision(
  input: ObservationProvisionCreation,
): Promise<void> {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  try {
    const provision = provisionSchema.parse({
      v: 1,
      receiverId: crypto.randomUUID(),
      bindingId: crypto.randomUUID(),
      origin: input.origin,
      independentKeyMaterialB64: Buffer.from(bytes).toString("base64"),
      keyEpoch: 1,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      allowLoopback: input.allowLoopback,
    });
    const file = await openPrivateObservationStateFile(input.path);
    try {
      try {
        await file.read();
        throw new Error("The receiver pairing file already exists.");
      } catch (error) {
        if (!z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
          throw error;
      }
      await file.write(JSON.stringify(provision));
    } finally {
      await file.close();
    }
  } finally {
    bytes.fill(0);
  }
}
