/** Strict primitive retired command snapshot; no verifier or physical effects. */
import { z } from "zod";
import { passwordBytes } from "./password-bytes.js";
import { MAX_RETIRED_RETENTION_MS } from "./retention-v2.js";
const changeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("enroll"),
    password: z.string().min(1).max(4096),
    response: z.enum(["reject", "synthetic_decoy"]),
    retentionMs: z
      .number()
      .int()
      .safe()
      .min(1)
      .max(MAX_RETIRED_RETENTION_MS)
      .optional(),
  }),
  z.strictObject({ type: z.literal("remove"), id: z.string().min(1).max(128) }),
  z.strictObject({ type: z.literal("clear-stale") }),
  z.strictObject({ type: z.literal("clear-events") }),
]);
export type RetiredRecordChange = z.infer<typeof changeSchema>;
/** Bounded primitive snapshot before asynchronous work; caller mutation must not change a collision-tested literal. */
export function readRetiredRecordChange(
  input: RetiredRecordChange,
): RetiredRecordChange {
  const value = changeSchema.parse(input);
  if (value.type === "enroll") {
    const bytes = passwordBytes(value.password);
    bytes.fill(0);
  }
  return Object.freeze(value);
}
