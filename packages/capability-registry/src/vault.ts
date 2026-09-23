import type { Capability } from "./index.js";
import { vaultFileCapabilities } from "./vault-files.js";
import { vaultLoginDraftCapabilities } from "./vault-login-draft.js";

/** The client-local vault surfaces: the on-screen login editor and vault files. */
export const vaultCapabilities: readonly Capability[] = [
  ...vaultLoginDraftCapabilities,
  ...vaultFileCapabilities,
];
