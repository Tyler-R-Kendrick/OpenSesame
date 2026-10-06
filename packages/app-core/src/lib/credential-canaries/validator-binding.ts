/** Owner-installed detector metadata. No vault header, root, receiver key or presented token. */
import { z } from "zod";
import {
  type CanaryArtifact,
  contextSchema,
  controlledIdentifierDigest,
} from "./protocol.js";
export const validatorBindingSchema = z
  .object({
    v: z.literal(1),
    validatorId: z.string().uuid(),
    artifactId: z.string().uuid(),
    context: contextSchema,
    digestB64: z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/),
  })
  .strict();
export type ControlledValidatorBinding = z.infer<typeof validatorBindingSchema>;
export function parseControlledValidatorBinding(
  raw: string,
): ControlledValidatorBinding {
  if (new TextEncoder().encode(raw).length > 4096)
    throw new Error("Validator binding exceeds limit.");
  const binding = validatorBindingSchema.parse(JSON.parse(raw));
  if (binding.context.kind !== "mcp_configuration")
    throw new Error("A controlled MCP binding is required.");
  return binding;
}
/** Called only by authenticated export or explicit human installation. */
export async function createControlledValidatorBinding(
  artifact: CanaryArtifact,
): Promise<ControlledValidatorBinding> {
  if (artifact.context.kind !== "mcp_configuration")
    throw new Error("A controlled MCP artifact is required.");
  return validatorBindingSchema.parse({
    v: 1,
    validatorId: crypto.randomUUID(),
    artifactId: artifact.id,
    context: artifact.context,
    digestB64: await controlledIdentifierDigest(
      artifact.context,
      artifact.presentedId,
    ),
  });
}
