/**
 * `backup.cloud-secrets` — sealed secrets mirrored to a cloud secret store
 * (the `cloud_secret_storage` family: Doppler, Infisical, AWS Secrets
 * Manager, HashiCorp Vault, …). Always on: that family's binding tiles are
 * drawn by Settings › Capabilities among the always-on provider groups, so
 * this module registers nothing of its own.
 *
 * What deliberately stays core: the AWS KMS, GCP KMS and Azure Key Vault
 * connector configuration and the age / SOPS panels under Settings ›
 * Security. They configure vault key *protectors*, which is the unlock path
 * (`vault.local-unlock`), not secret storage.
 *
 * Egress this module wraps: none of its own today — bindings are recorded
 * in settings, and the connector pages that authorize them belong to
 * `connectors.external`.
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "backup.cloud-secrets";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    return createActivation(ctx, CAPABILITY).handle();
  },
};
