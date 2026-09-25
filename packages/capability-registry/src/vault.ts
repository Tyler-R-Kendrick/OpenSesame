import type { Capability } from "./index.js";
import { vaultFileCapabilities } from "./vault-files.js";
import { vaultLoginDraftCapabilities } from "./vault-login-draft.js";
import { vaultTravelCapabilities } from "./vault-travel.js";

/** The client-local vault surfaces: the login editor, vault files and travel. */
export const vaultCapabilities: readonly Capability[] = [
  ...vaultLoginDraftCapabilities,
  ...vaultFileCapabilities,
  ...vaultTravelCapabilities,
];
