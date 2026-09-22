/**
 * `backup.git-remote` — encrypted history and vault backups over git
 * remotes: the GitHub App target the gateway pushes to (ADR 0039), the
 * browser-held forge remotes (GitHub / GitLab / Bitbucket / Codeberg /
 * generic git / password-store, ADR 0090), and the repository picker on a
 * connector's settings page.
 *
 * Contributed: the Backups settings category (the backup/recovery tiles
 * that used to sit in Settings › Connections) and the backup tutorial
 * descriptors. The per-connector pages (`GithubInstallationPanel`,
 * `GithubHistoryRemotePicker`, `BackupSyncControls`) are reached through
 * `connectors.external`'s connector route, which is that capability's
 * surface; they stay where they are and are listed in the catalog as this
 * capability's dependency on it.
 *
 * Egress this module wraps (existing transport code):
 *  - Connect relay at `connectCallbackBase()`: `/api/github-app/lookup`,
 *    `/api/github-app/installations`, `/api/github-app/convert`,
 *    `/api/github-app/repos*` (`lib/github-app-local.ts`,
 *    `lib/github-app-claim.ts`, `lib/github-app-repos.ts`) — user-initiated
 *    (register App, list installations, pick a repository).
 *  - Host API `/api/v1/backup/*`, `/api/v1/providers/github/*` via
 *    `hostFetch` (`lib/backup.ts`, `lib/github-history.ts`) —
 *    `getBackupStatus` runs automatically when a settings panel mounts and
 *    a Host is configured; the rest is user-initiated.
 *  - Navigation to `github.com/apps/...` install pages — user-initiated.
 * Provisional history-account claims (`claimProvisionalHistoryAccounts`)
 * run from `lib/guest-auth.ts` at registered sign-in, not at unlock; they
 * are not an unlock effect and are left where they are (see the report).
 *
 * Exclusive to this chunk: GitHub App manifest/claim/repos clients and the
 * forge remote store. No third-party git or GitHub SDK is used.
 */

import type { CapabilityRuntime } from "../../lib/capabilities/runtime-contract.js";
import { createActivation } from "../activation.js";
import { registerTutorial } from "../tutorial-contributions.js";
import { BackupBindingsPanel } from "./BackupBindingsPanel.js";

export const CAPABILITY = "backup.git-remote";

export const TUTORIAL = {
  targets: ["settings.backup"],
  goals: ["settings.backup"],
} as const;

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.register("settings-category", {
      id: "backups",
      label: "Backups",
      guideId: "settings.backup",
      Panel: BackupBindingsPanel,
      order: 45,
    });
    registerTutorial(activation, TUTORIAL);

    return activation.handle();
  },
};
