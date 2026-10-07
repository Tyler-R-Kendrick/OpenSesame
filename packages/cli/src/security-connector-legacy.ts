import {
  discardIrrecoverableLegacyConnectorSecrets,
  refreshLegacyDeviceConnectorStatus,
  resolveLegacyDeviceConnectors,
} from "@opensesame/app-core/lib/device-connector-legacy.js";
import { emit } from "./output.js";
import type { LegacyConnectorCommand } from "./parse-connector-legacy.js";
import { withSecurityOwner } from "./security-owner.js";
import type { VaultItemDependencies } from "./vault-items.js";

/** Human-only legacy migration; submitted passwords are never command arguments. */
export function runSecurityConnectorLegacy(
  command: LegacyConnectorCommand,
  deps: VaultItemDependencies = {},
): Promise<number> {
  return withSecurityOwner(
    command.name !== "security-connectors-legacy-status",
    deps,
    async (proof) => {
      if (command.name === "security-connectors-legacy-discard-all")
        await discardIrrecoverableLegacyConnectorSecrets({
          ...proof,
          acknowledgeIrrecoverableLegacyDiscard: true,
        });
      if (command.name === "security-connectors-legacy-resolve")
        await resolveLegacyDeviceConnectors({
          ...proof,
          connectionIds: command.connectionIds,
          decision: command.decision,
          acknowledgeOwnershipAmbiguity: true,
        });
      const status = await refreshLegacyDeviceConnectorStatus(proof.tomb);
      emit(command.flags, JSON.stringify(status, null, 2), {
        ok: true,
        ...status,
      });
      return 0;
    },
  );
}
