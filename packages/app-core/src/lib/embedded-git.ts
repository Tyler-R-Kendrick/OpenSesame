import type { Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import { hasLocalGitRemotes } from "./git-remote-local.js";

const LABELS: Readonly<Record<string, string>> = {
  remote_url: "Remote URL",
  auth_mode: "Auth mode",
  ssh_private_key: "SSH private key",
  ssh_passphrase: "SSH key passphrase",
};

/** Bundled forge-agnostic git remote for backup/recovery (catalog row `git`). */
export function bundledGitProvider(): Provider {
  const provider = catalogProvider("git");
  if (!provider)
    throw new Error("git is not a row of spec/connectors/catalog.json");
  provider.configured = hasLocalGitRemotes();
  provider.configurationFields = provider.configurationFields?.map((field) => ({
    ...field,
    label: LABELS[field.name] ?? field.label,
  }));
  return provider;
}
