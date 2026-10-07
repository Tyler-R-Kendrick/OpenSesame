/** Exact OPFS error classifiers, loaded only when an I/O operation fails. */
import { z } from "zod";

export const missingFileError = z.object({ name: z.literal("NotFoundError") });
export const restrictedFileError = z.object({
  name: z.enum(["NoModificationAllowedError", "SecurityError"]),
});
