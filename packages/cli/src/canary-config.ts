import { parseControlledValidatorBinding } from "@opensesame/app-core/lib/credential-canaries/index.js";
import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import { MAX_CANARY_CONFIGURATION_BYTES } from "./canary-export-template.js";
export const bindingSchema = z
  .object({
    v: z.literal(1),
    tomb: z.string().min(1).max(256),
    artifact: z
      .object({
        id: z.string().min(1).max(128),
        presentedId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        context: z
          .object({
            vaultIdentity: z.string().min(1).max(256),
            kind: z.literal("mcp_configuration"),
            generation: z.number().int().min(1).max(0xffffffff),
          })
          .strict(),
      })
      .strict(),
    mcpServers: z
      .object({
        OpenSesameCanary: z
          .object({
            command: z.string().max(128),
            args: z.array(z.string().max(4096)).max(8),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export function parseCanaryConfiguration(raw: string) {
  if (new TextEncoder().encode(raw).length > MAX_CANARY_CONFIGURATION_BYTES)
    throw new Error("Canary configuration exceeds 4 KiB.");
  const value: BoundaryValue = JSON.parse(raw);
  if (!isJsonObject(value)) throw new Error("Canary configuration is invalid.");
  const { validatorBinding, ...base } = value;
  const config = bindingSchema.parse(base);
  const binding =
    validatorBinding === undefined
      ? undefined
      : parseControlledValidatorBinding(JSON.stringify(validatorBinding));
  return { ...config, validatorBinding: binding };
}
