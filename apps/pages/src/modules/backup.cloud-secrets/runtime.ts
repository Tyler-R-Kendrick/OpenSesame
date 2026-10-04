/**
 * `backup.cloud-secrets` — sealed secrets mirrored to a cloud secret store
 * (the `cloud_secret_storage` family: Doppler, Infisical, AWS Secrets
 * Manager, HashiCorp Vault, …). Always on: that family's binding tiles are
 * drawn by Settings › Capabilities among the always-on provider groups.
 *
 * It also draws the SOPS document panel under Settings › Security (ADR 0130
 * §1): a person with no account opens, edits and saves an upstream SOPS file
 * in this browser. It is a `settings-panel`, so Security lists it without
 * importing the sheet.
 *
 * What deliberately stays core: the AWS KMS and Google Cloud KMS connection
 * configuration under Settings › Security. It configures vault key
 * *protectors*, which is the unlock path (`vault.local-unlock`), not secret
 * storage.
 *
 * Egress this module wraps: none of its own today — bindings are recorded
 * in settings, and the connector pages that authorize them belong to
 * `connectors.external`.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  type FeatureOperation,
  runListedFeature,
} from "@opensesame/app-core/lib/feature-connector-operation.js";
import {
  performSavedConnector,
  registerCategorySend,
} from "@opensesame/app-core/lib/feature-request-send.js";
import type { FeatureRequest } from "@opensesame/app-core/lib/feature-request.js";

import { applySavedConnectors } from "../../lib/apply-saved-connectors.js";
import { SopsDocumentPanel } from "../../sections/settings/sops/SopsDocumentPanel.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "backup.cloud-secrets";

/** Cloud secret storage and encryption connectors saved on this device. */
export function savedStorageOperation(
  provider: Provider | string,
): FeatureOperation {
  return runListedFeature(provider);
}

export function applySavedStorageConnectors(): FeatureOperation[] {
  return applySavedConnectors(
    ["cloud_secret_storage", "encryption"],
    savedStorageOperation,
  );
}

export function startStorageConnectors(): FeatureRequest[] {
  return applySavedStorageConnectors().map((operation) =>
    storageOperation(operation.providerId),
  );
}

export function storageOperation(providerId: string): FeatureRequest {
  return performSavedConnector(providerId);
}

/** Send saved cloud and encryption connectors when a backup sync runs. */
export function runSavedStorageConnectors(): FeatureRequest[] {
  return startStorageConnectors();
}

/** Security's SOPS row: one key that opens the document sheet. */
export const SOPS_DOCUMENT_PANEL = {
  id: "sops-document",
  label: "SOPS",
  category: "security",
  Panel: SopsDocumentPanel,
  order: 40,
};

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();
    const releaseStorage = registerCategorySend(
      "cloud_secret_storage",
      runSavedStorageConnectors,
    );
    const releaseEncryption = registerCategorySend(
      "encryption",
      runSavedStorageConnectors,
    );
    activation.onDispose(releaseStorage);
    activation.onDispose(releaseEncryption);
    activation.register("settings-panel", SOPS_DOCUMENT_PANEL);
    return activation.handle();
  },
};
