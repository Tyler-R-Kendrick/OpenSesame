import type { Provider } from "./connections.js";
import { hasLocalGitRemotes } from "./git-remote-local.js";

/** Bundled forge-agnostic git remote for backup/recovery. */
export function bundledGitProvider(): Provider {
  return {
    id: "git",
    displayName: "Git (any remote)",
    category: "backup_recovery",
    docsUrl: "https://git-scm.com/docs/gitcredentials",
    authKind: "configuration",
    supportsRefresh: false,
    configured: hasLocalGitRemotes(),
    autoConfigurable: false,
    missingConfig: [],
    callbackUrl: null,
    scopes: [],
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    operations: ["git.fetch", "git.push"],
    configurationFields: [
      {
        name: "remote_url",
        label: "Remote URL",
        secret: false,
        required: true,
      },
      { name: "auth_mode", label: "Auth mode", secret: false, required: true },
      {
        name: "username",
        label: "Username",
        secret: false,
        required: false,
      },
      { name: "token", label: "Token", secret: true, required: false },
      { name: "password", label: "Password", secret: true, required: false },
      {
        name: "ssh_private_key",
        label: "SSH private key",
        secret: true,
        required: false,
      },
      {
        name: "ssh_passphrase",
        label: "SSH key passphrase",
        secret: true,
        required: false,
      },
    ],
  };
}
