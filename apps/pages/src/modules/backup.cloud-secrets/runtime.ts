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
import {
  type FeatureRequest,
  dispatchFeatureCall,
  dispatchedFeatureCall,
  rememberUses,
} from "@opensesame/app-core/lib/feature-request.js";
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

let storageReady: FeatureRequest[] = [];

export function startStorageConnectors(): FeatureRequest[] {
  const requests = applySavedStorageConnectors().map((operation) =>
    operation.ok
      ? dispatchFeatureCall({
          ok: true,
          providerId: operation.providerId,
          operation: operation.operation,
          fields: { ...operation.action },
          secret: { ...operation.secrets },
        })
      : { ok: false as const, providerId: operation.providerId },
  );
  storageReady = rememberUses(requests);
  return storageReady.map((use) => storageOperation(use.providerId));
}

export function storageOperation(providerId: string): FeatureRequest {
  const call = dispatchedFeatureCall(providerId);
  if (
    !call ||
    !storageReady.some((use) => use.ok && use.providerId === providerId)
  ) {
    return { ok: false, providerId };
  }
  return {
    ok: true,
    providerId,
    operation: call.operation,
    fields: { ...call.fields },
    secret: { ...call.secret },
  };
}

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    storageReady = startStorageConnectors();
    return activation.handle();
  },
};
