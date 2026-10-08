/** Responses come only from an installed issuer, never public owner arguments. */
import { b64ToBytes, bytesToB64 } from "@opensesame/vault-core";
import { z } from "zod";
import {
  contextSchema,
  decodePresentedId,
  presentedIdSchema,
} from "./protocol.js";
import { artifactRecordSchema } from "./records.js";
const issuerResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("presented_identifier"),
      presentedId: presentedIdSchema,
      context: contextSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("authenticated_retired_artifact"),
      artifact: artifactRecordSchema.extend({
        state: z.literal("retired"),
        retiredAt: z.string().datetime(),
      }),
      binding: z
        .object({
          tomb: z.string().min(1).max(256),
          vaultIdentity: z.string().min(1).max(256),
        })
        .strict(),
    })
    .strict(),
]);
export type CredentialCanaryIssuerResponse = z.infer<
  typeof issuerResponseSchema
>;
/** Validate independently of the transport's authentication and original owner proof. */
export function validateCredentialCanaryIssuerResponse(
  response: CredentialCanaryIssuerResponse,
  tomb: string,
  identity: string,
) {
  const parsed = issuerResponseSchema.parse(response);
  if (parsed.kind === "presented_identifier") {
    decodePresentedId(parsed.presentedId);
    if (parsed.context.kind === "mcp_configuration")
      throw new Error(
        "Configuration bait is not retired production authority.",
      );
    if (parsed.context.vaultIdentity !== identity)
      throw new Error("Issuer context mismatch.");
    return parsed;
  }
  const { artifact, binding } = parsed;
  if (artifact.context.kind === "mcp_configuration")
    throw new Error("Configuration bait is not retired production authority.");
  if (
    binding.tomb !== tomb ||
    binding.vaultIdentity !== identity ||
    artifact.context.vaultIdentity !== identity
  )
    throw new Error("Issuer context mismatch.");
  const digest = b64ToBytes(artifact.digestB64);
  if (digest.length !== 32 || bytesToB64(digest) !== artifact.digestB64)
    throw new Error("Issuer digest is not canonical.");
  if (Date.parse(artifact.retiredAt) < Date.parse(artifact.createdAt))
    throw new Error("Issuer retirement precedes issuance.");
  return parsed;
}
