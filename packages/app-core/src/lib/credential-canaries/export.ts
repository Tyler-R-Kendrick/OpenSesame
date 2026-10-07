import { verifyControlledArtifact } from "./observe.js";
/** Export only a caller-held, still-enrolled opaque artifact. */
import { withCredentialObservationOwner } from "./owner.js";
import type { CanaryArtifact, OwnerProof } from "./protocol.js";
import { createControlledValidatorBinding } from "./validator-binding.js";
export function exportControlledMcpConfiguration(
  input: OwnerProof & {
    artifact: CanaryArtifact;
    suppliedValidatorRef: string;
  },
) {
  return withCredentialObservationOwner(
    input,
    async (_identity, assertAuthorized) => {
      if (
        input.suppliedValidatorRef !== "human_cli_stdio" ||
        input.artifact.context.kind !== "mcp_configuration"
      )
        throw new Error("Unknown controlled validator binding.");
      await verifyControlledArtifact(
        input.tomb,
        input.artifact,
        true,
        assertAuthorized,
      );
      return {
        v: 1 as const,
        tomb: input.tomb,
        artifact: input.artifact,
        validatorBinding: await createControlledValidatorBinding(
          input.artifact,
        ),
        mcpServers: {
          OpenSesameCanary: {
            command: "opensesame-id",
            args: ["canary", "serve", "--config", "<config-file>"],
          },
        },
      };
    },
  );
}
