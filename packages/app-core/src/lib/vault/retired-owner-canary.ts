/** Primitive canary command snapshots only; no identity token establishes owner authority. */
import type { LocalCanaryCommand } from "@opensesame/vault-core/local-vault-security.js";
import { z } from "zod";
import { copyCanaryReceiverProfile } from "../agent-canaries/receiver-profile-data.js";
const action = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pairing") }),
  z.strictObject({ kind: z.literal("inspect") }),
  z.strictObject({
    kind: z.literal("enroll"),
    label: z.string().min(1).max(80),
    artifactKind: z.enum(["mcp-config", "connection-reference"]),
    retentionDays: z.number().int().min(1).max(90),
    ownerConsent: z.literal(true),
  }),
  z.strictObject({
    kind: z.literal("remove"),
    id: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.strictObject({
    kind: z.literal("export"),
    id: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
]);
export function copyRetiredOwnerCanaryCommand(
  input: LocalCanaryCommand,
): LocalCanaryCommand {
  if (Object.keys(input).length !== 2)
    throw new Error("Unsupported canary command.");
  return Object.freeze({
    receiver: copyCanaryReceiverProfile(input.receiver),
    action: Object.freeze(action.parse(input.action)),
  });
}
