/** Primitive owner requests copied synchronously before operation suspension. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { passwordBytes } from "../retired-credentials/password-bytes.js";
const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("password"), secret: z.string().max(4096) }),
  z.strictObject({ kind: z.literal("pin"), secret: z.string().max(4096) }),
  z.strictObject({ kind: z.literal("passkey") }),
  z.strictObject({
    kind: z.literal("protector"),
    method: z.enum(["recovery", "age", "agePasskey"]),
    secret: z.string().max(4096).optional(),
  }),
]);
export type CapturedOwnerPrimaryRequest = z.infer<typeof requestSchema>;
/** Primitive requests copied before asynchronous work; test crypto/verdicts/roots are never input. */
export function copyCapturedOwnerPrimaryRequest(input: BoundaryValue) {
  const request = requestSchema.parse(input);
  if ("secret" in request && request.secret !== undefined) {
    const bytes = passwordBytes(request.secret);
    bytes.fill(0);
  }
  return Object.freeze(request);
}
