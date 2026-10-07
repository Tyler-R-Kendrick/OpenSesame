import {
  configureObservationReceiver,
  getObservationReceiverStatus,
  parseObservationReceiverProvision,
  removeObservationReceiver,
  setObservationReceiverEnabled,
  testObservationReceiver,
} from "@opensesame/app-core/lib/credential-observation/index.js";
import { emit } from "./output.js";
import type { SecurityCommand } from "./parse-security.js";
import { readSecurityFile } from "./security-files.js";
import { withSecurityOwner } from "./security-owner.js";
import type { VaultItemDependencies } from "./vault-items.js";

type ReceiverCommand = Extract<
  SecurityCommand,
  { name: `security-receiver-${string}` }
>;
export function runSecurityReceiver(
  command: ReceiverCommand,
  deps: VaultItemDependencies = {},
): Promise<number> {
  return withSecurityOwner(
    command.name !== "security-receiver-status",
    deps,
    async (proof) => {
      if (command.name === "security-receiver-configure") {
        const provision = parseObservationReceiverProvision(
          await readSecurityFile(command.pairingFile),
        );
        await configureObservationReceiver({
          ...proof,
          provision,
          enabled: false,
        });
      }
      if (command.name === "security-receiver-remove")
        await removeObservationReceiver(proof);
      if (command.name === "security-receiver-enabled")
        await setObservationReceiverEnabled({
          ...proof,
          enabled: command.enabled,
        });
      const test =
        command.name === "security-receiver-test"
          ? await testObservationReceiver(proof)
          : undefined;
      const status = await getObservationReceiverStatus(proof.tomb);
      const payload: typeof status & { ok: boolean; testDelivered?: boolean } =
        {
          ok: true,
          ...status,
        };
      if (test) payload.testDelivered = test.delivered;
      emit(
        command.flags,
        status.configured
          ? `Receiver ${status.origin}: ${status.enabled ? "enabled" : "disabled"}; ${status.queued} queued.`
          : "Local evidence only. No receiver configured.",
        payload,
      );
      return 0;
    },
  );
}
