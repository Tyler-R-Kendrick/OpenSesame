/**
 * `backup.cloud-secrets` — sealed secrets mirrored to a cloud secret store
 * (the `cloud_secret_storage` family: Doppler, Infisical, AWS Secrets
 * Manager, HashiCorp Vault, …). Always on: that family's binding tiles are
 * drawn by Settings › Capabilities among the always-on provider groups, so
 * this module registers nothing of its own.
 *
 * What deliberately stays core: the AWS KMS and Google Cloud KMS connection
 * configuration and the age / SOPS panels under Settings › Security. They
 * configure vault key *protectors*, which is the unlock path
 * (`vault.local-unlock`), not secret storage.
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
import { performSavedConnector } from "@opensesame/app-core/lib/feature-request-send.js";
import type { FeatureRequest } from "@opensesame/app-core/lib/feature-request.js";
import { bindFeatureUse } from "@opensesame/app-core/lib/feature-use-binding.js";
import { applySavedConnectors } from "../../lib/apply-saved-connectors.js";
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

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    activation.onDispose(
      bindFeatureUse("storage", () => {
        startStorageConnectors();
      }),
    );
    startStorageConnectors();
    return activation.handle();
  },
};
