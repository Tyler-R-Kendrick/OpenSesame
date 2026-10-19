import type { Capability } from "./index.js";
import { passwordProviderCapabilities } from "./password-provider.js";
import { passwordRequestCapabilities } from "./password-requests.js";
import { passwordWorkflowCapabilities } from "./password-workflows.js";
import { vaultCircleCapabilities } from "./vault-circle.js";
import { vaultCliCapabilities } from "./vault-cli.js";
import { vaultDuressCapabilities } from "./vault-duress.js";
import { vaultEnvironmentCapabilities } from "./vault-environments.js";
import { vaultFileCapabilities } from "./vault-files.js";
import { vaultInteropCapabilities } from "./vault-interop.js";
import { vaultLoginDraftCapabilities } from "./vault-login-draft.js";
import { vaultProtectionCapabilities } from "./vault-protection.js";
import { retiredCanaryCapabilities } from "./vault-retired-canaries.js";
import { vaultTravelCapabilities } from "./vault-travel.js";

/**
 * The client-local vault surfaces: the login editor, vault files, import and
 * export, travel, and key protection.
 */
export const vaultCapabilities: readonly Capability[] = [
  ...passwordWorkflowCapabilities,
  ...passwordProviderCapabilities,
  ...passwordRequestCapabilities,
  ...vaultLoginDraftCapabilities,
  ...vaultFileCapabilities,
  ...vaultCircleCapabilities,
  ...vaultCliCapabilities,
  ...vaultEnvironmentCapabilities,
  ...vaultInteropCapabilities,
  ...vaultTravelCapabilities,
  ...vaultDuressCapabilities,
  ...vaultProtectionCapabilities,
  ...retiredCanaryCapabilities,
];
