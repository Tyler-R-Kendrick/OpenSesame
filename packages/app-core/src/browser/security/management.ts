import { assertNotDecoySession } from "../../lib/decoy-session.js";
import { retiredCredentialOwnerSeams } from "../../lib/retired-credentials/index.js";
import { vaultStore } from "../../lib/vault/store.js";
import { PERSONAL_TOMB } from "../../lib/vfs.js";
import { classifyExtensionPassword, initializeExtensionVault } from "./core.js";
import type { ManagementOperation } from "./management-wire.js";

async function execute(
  operation: ManagementOperation,
  currentPassword: string,
) {
  const proof = { tomb: PERSONAL_TOMB, currentPassword };
  if (operation.verb.startsWith("legacy-"))
    return executeLegacy(operation, currentPassword);
  if (operation.verb.startsWith("canary-")) {
    const api = await import("../../lib/credential-canaries/index.js");
    if (operation.verb === "canary-issued-status") {
      const issuer = await import(
        "../../lib/capabilities/lease-canary-issuer.js"
      );
      return { issued: issuer.listRetiredLeaseIdentifiers(PERSONAL_TOMB) };
    }
    if (operation.verb === "canary-retire")
      await api.retireIssuedIdentifier({
        ...proof,
        issuerRecordRef: operation.issuerRecordRef,
      });
    if (operation.verb === "canary-status")
      return api.listControlledCanaries(PERSONAL_TOMB);
    if (operation.verb === "canary-clear")
      await api.clearControlledCanaryEvents(proof);
    if (operation.verb === "canary-remove")
      await api.removeControlledCanary({
        ...proof,
        artifactId: operation.artifactId,
      });
    if (operation.verb === "canary-create") {
      const artifact = await api.createControlledCanary({
        ...proof,
        kind: operation.kind,
      });
      const configuration =
        operation.kind === "mcp_configuration"
          ? await api.exportControlledMcpConfiguration({
              ...proof,
              artifact,
              suppliedValidatorRef: "human_cli_stdio",
            })
          : undefined;
      if (configuration) return { artifact, configuration };
      return { artifact };
    }
    return api.listControlledCanaries(PERSONAL_TOMB);
  }
  const api = await import("../../lib/credential-observation/index.js");
  if (operation.verb === "receiver-configure")
    await api.configureObservationReceiver({
      ...proof,
      provision: api.parseObservationReceiverProvision(operation.pairingJson),
      enabled: false,
    });
  if (operation.verb === "receiver-remove")
    await api.removeObservationReceiver(proof);
  if (operation.verb === "receiver-enabled")
    await api.setObservationReceiverEnabled({
      ...proof,
      enabled: operation.enabled,
    });
  if (operation.verb === "receiver-test")
    return api.testObservationReceiver(proof);
  return api.getObservationReceiverStatus(PERSONAL_TOMB);
}
async function executeLegacy(
  operation: ManagementOperation,
  currentPassword: string,
) {
  const api = await import("../../lib/device-connector-legacy.js");
  if (operation.verb === "legacy-discard-corrupt")
    await api.discardIrrecoverableLegacyConnectorSecrets({
      tomb: PERSONAL_TOMB,
      currentPassword,
      acknowledgeIrrecoverableLegacyDiscard: true,
    });
  if (operation.verb === "legacy-resolve")
    await api.resolveLegacyDeviceConnectors({
      tomb: PERSONAL_TOMB,
      currentPassword,
      connectionIds: operation.connectionIds,
      decision: operation.decision,
      acknowledgeOwnershipAmbiguity: operation.acknowledgeOwnershipAmbiguity,
    });
  const status = await api.refreshLegacyDeviceConnectorStatus(PERSONAL_TOMB);
  return { ...status, records: status.records.slice(0, 16) };
}
/** Worker-only serialized fresh owner proof; a page permit alone never authorizes management. */
export async function manageExtensionSecurity(
  operation: ManagementOperation,
  password: string,
  check: () => void,
): Promise<string> {
  await initializeExtensionVault();
  check();
  const admission = await classifyExtensionPassword(password);
  check();
  if (admission.realm !== "real")
    throw new Error("Fresh real owner authentication is required.");
  const previous = retiredCredentialOwnerSeams.isRealOwner;
  try {
    vaultStore.lock();
    vaultStore.loadActiveProjectScope();
    await vaultStore.unlock(password);
    check();
    assertNotDecoySession();
    const state = vaultStore.getSnapshot();
    if (
      state.status !== "unlocked" ||
      state.guest ||
      state.decoy ||
      state.awaitingSecondStep
    )
      throw new Error("Fresh real owner authentication is required.");
    retiredCredentialOwnerSeams.isRealOwner = (tomb) => {
      check();
      const state = vaultStore.getSnapshot();
      return (
        state.tomb === tomb &&
        state.status === "unlocked" &&
        !state.guest &&
        !state.decoy &&
        !state.awaitingSecondStep
      );
    };
    const result = await execute(operation, password);
    check();
    const encoded = JSON.stringify(result);
    if (new TextEncoder().encode(encoded).length > 32768)
      throw new Error("Management reply exceeds its limit.");
    return encoded;
  } finally {
    vaultStore.lock();
    retiredCredentialOwnerSeams.isRealOwner = previous;
  }
}
