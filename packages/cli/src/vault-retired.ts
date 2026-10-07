import { assertNotDecoySession } from "@opensesame/app-core/lib/decoy-session.js";
import { flushRetiredCredentialTelemetry } from "@opensesame/app-core/lib/retired-credentials/index.js";
import {
  clearRetiredCredentialEvents,
  enrollRetiredCredential,
  refreshRetiredCredentialStatus,
  removeRetiredCredential,
  retiredCredentialEnrollmentSupported,
} from "@opensesame/app-core/lib/retired-credentials/index.js";
import { emit } from "./output.js";
import type { RetiredCredentialCommand } from "./parse-retired.js";
import { readPasswordFromTty } from "./tty-password.js";
import type { VaultItemDependencies } from "./vault-items.js";
import { openLocalVault, unlockLocalVault } from "./vault-session.js";

/** Owner-only local CLI ceremony; never an MCP tool or credential argument. */
export async function runVaultRetired(
  command: RetiredCredentialCommand,
  deps: VaultItemDependencies = {},
): Promise<number> {
  const store = await openLocalVault(deps.stateDir);
  try {
    if (store.getSnapshot().status === "empty")
      throw new Error("Create a vault before managing retired credentials.");
    const readPassword = deps.readPassword ?? readPasswordFromTty;
    const currentPassword = await readPassword("Current vault password: ");
    await unlockLocalVault(store, currentPassword);
    assertNotDecoySession();
    const state = store.getSnapshot();
    if (state.guest || state.awaitingSecondStep)
      throw new Error(
        "Complete real owner authentication before managing retired credentials.",
      );
    const tomb = store.activeTomb();
    if (
      command.name !== "vault-retired-status" &&
      !retiredCredentialEnrollmentSupported(tomb)
    )
      throw new Error(
        "Retired credential management requires one verified password protector and no additional factors. This CLI cannot complete the required owner ceremony for this vault.",
      );
    switch (command.name) {
      case "vault-retired-enroll":
        await enrollRetiredCredential({
          tomb,
          currentPassword,
          retiredPassword: await readPassword("Selected retired password: "),
          response: command.response,
          acknowledgePasswordVerifierRisk: true,
        });
        break;
      case "vault-retired-remove":
        await removeRetiredCredential({
          tomb,
          currentPassword,
          id: command.id,
        });
        break;
      case "vault-retired-clear":
        await clearRetiredCredentialEvents({ tomb, currentPassword });
        break;
      case "vault-retired-status":
        break;
    }
    const status = await refreshRetiredCredentialStatus(tomb);
    emit(
      command.flags,
      [
        `${status.traps.length} retired password traps; ${status.events.length} local observations.`,
        ...status.traps.map(
          (trap) =>
            `${trap.id}: ${trap.response === "reject" ? "Record and reject" : "Synthetic vault"}`,
        ),
        "Use --json to inspect local observation metadata.",
      ].join("\n"),
      { ok: true, localOnly: true, ...status },
    );
    return 0;
  } finally {
    await flushRetiredCredentialTelemetry();
    store.lock();
  }
}
