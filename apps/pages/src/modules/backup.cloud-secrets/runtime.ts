/**
 * `backup.cloud-secrets` — sealed secrets mirrored to a cloud secret store
 * (the `cloud_secrets` capability family: Doppler, Infisical, AWS Secrets
 * Manager, HashiCorp Vault, …). Contributed: the Cloud secrets settings
 * category with that family's binding tiles.
 *
 * What deliberately stays core: the AWS KMS, GCP KMS and Azure Key Vault
 * connector configuration (`lib/aws-kms-config.ts`, `lib/gcp-kms-config.ts`,
 * `lib/azure-key-vault-keys-config.ts`, `sections/connections/*Kms*`,
 * `*AzureKeyVault*`) and the age / SOPS panels under Settings › Security.
 * They configure vault key *protectors* (`lib/vault/protection/adapters`),
 * which is the unlock path (`vault.local-unlock`), not secret storage. A
 * disabled cloud-secrets capability must never take a protector with it.
 *
 * Egress this module wraps: none of its own today — bindings are recorded
 * in settings, and the connector pages that authorize them belong to
 * `connectors.external` (Host API via `hostFetch`, user-initiated). The
 * guide target reused for the category link is `settings.backup`; no
 * cloud-secrets descriptor is authored yet (see the report).
 */

import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";
import { CloudSecretBindingsPanel } from "./CloudSecretBindingsPanel.js";

export const CAPABILITY = "backup.cloud-secrets";

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.register("settings-category", {
      id: "cloud-secrets",
      label: "Cloud secrets",
      guideId: "settings.backup",
      Panel: CloudSecretBindingsPanel,
      order: 46,
    });

    return activation.handle();
  },
};
