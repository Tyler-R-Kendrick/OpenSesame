/** Exact high-entropy identifiers. Never use this digest for human passwords. */
import { bytesToB64 } from "@opensesame/vault-core";
import { z } from "zod";
import { decodePresentedId } from "./identifier.js";
export {
  controlledCanaryReference,
  decodePresentedId,
  encodePresentedId,
  parseControlledCanaryReference,
} from "./identifier.js";
export const artifactKindSchema = z.enum([
  "connection_ref",
  "mcp_configuration",
  "token_generation",
  "agent_lease",
]);
export const contextSchema = z
  .object({
    vaultIdentity: z.string().min(1).max(256),
    kind: artifactKindSchema,
    generation: z.number().int().min(1).max(4294967295),
  })
  .strict();
export const presentedIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type ArtifactContext = z.infer<typeof contextSchema>;
export type CanaryArtifact = {
  id: string;
  context: ArtifactContext;
  presentedId: string;
};
export type OwnerProof = { tomb: string; currentPassword: string };
function u32(n: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n);
  return bytes;
}
export async function controlledIdentifierDigest(
  context: ArtifactContext,
  id: string,
): Promise<string> {
  contextSchema.parse(context);
  const encoder = new TextEncoder();
  const identity = encoder.encode(context.vaultIdentity);
  const kind = encoder.encode(context.kind);
  const parts = [
    encoder.encode("OpenSesame credential canary v1\0"),
    u32(identity.length),
    identity,
    u32(kind.length),
    kind,
    u32(context.generation),
    decodePresentedId(id),
  ];
  const input = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    input.set(part, offset);
    offset += part.length;
  }
  return bytesToB64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", input)),
  );
}
