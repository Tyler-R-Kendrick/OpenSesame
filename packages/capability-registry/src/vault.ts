import type { Capability } from "./index.js";
import { vaultDuressCapabilities } from "./vault-duress.js";
import { vaultFileCapabilities } from "./vault-files.js";
import { vaultInteropCapabilities } from "./vault-interop.js";
import { vaultLoginDraftCapabilities } from "./vault-login-draft.js";
import { vaultTravelCapabilities } from "./vault-travel.js";

/**
 * The client-local vault surfaces: the login editor, vault files, import and
 * export, and travel.
 */
export const vaultCapabilities: readonly Capability[] = [
  ...vaultLoginDraftCapabilities,
  ...vaultFileCapabilities,
  ...vaultInteropCapabilities,
  ...vaultTravelCapabilities,
  ...vaultDuressCapabilities,
];
