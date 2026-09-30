/**
 * `backup.git-remote` — encrypted history and vault backups over git
 * remotes: the GitHub App target the gateway pushes to (ADR 0039), the
 * browser-held forge remotes (GitHub / GitLab / Bitbucket / Codeberg /
 * generic git / password-store, ADR 0090), and the repository picker on a
 * connector's settings page.
 *
 * Always on (ADR 0142): it runs entirely in the browser, and a git history
 * remote already defaults to GitHub, so the default installation has it.
 * Settings › Capabilities draws its tiles (the git providers) under Backups.
 * Contributed: the backup observer as a background job, held off by a plan
 * that denies external services. The Connections section is optional
 * (ADR 0153) and this capability does not depend on it. Connector settings
 * (`GithubInstallationPanel`, `GithubBackupRepoCombobox`,
 * `BackupSyncControls`) stay on `connectors.external` and are absent until
 * that section is on.
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

import { backupEgressGate } from "@opensesame/app-core/lib/backup-egress-gate.js";
import type { CapabilityRuntime } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  type FeatureOperation,
  runListedFeature,
} from "@opensesame/app-core/lib/feature-connector-operation.js";
import {
  type FeatureRequest,
  dispatchFeatureCall,
  savedFeatureRequests,
} from "@opensesame/app-core/lib/feature-request.js";
import { HISTORY_BACKUP_GROUPS } from "@opensesame/app-core/lib/history-backups.js";
import {
  startVaultBackupObserver,
  stopVaultBackupObserver,
} from "@opensesame/app-core/lib/vault-backup-observer.js";
import {
  bindSavedGitBackup,
  savedGitBackupUse,
} from "@opensesame/app-core/lib/vault-backup-sync.js";
import { createActivation } from "../activation.js";

export const CAPABILITY = "backup.git-remote";

/**
 * The observer is what makes this capability's egress automatic: it follows
 * the vault store, nudges a sync after a mutation, and polls the GitHub App
 * relay for webhook-pending events. It used to be started from whichever
 * settings panel happened to mount (`BackupSyncControls`) and from
 * `enableBackup`, so it outlived the surface that started it. As a
 * background job it runs exactly while this capability is active.
 *
 * Every road out of it is already fenced by a bound, enabled target: with
 * none configured `runSync` returns before any request and the webhook
 * drain returns 0 without a fetch. Disabling the capability calls
 * `stopVaultBackupObserver`, which only unsubscribes and clears the timer —
 * no request, no write, no ceremony.
 */
export const BACKUP_OBSERVER_JOB = "vault-backup-observer";

/** A forge or history connector's saved operation. Secrets stay on the operation. */
export function savedGitBackupOperation(
  provider: Provider | string,
): FeatureOperation {
  return runListedFeature(provider);
}

/** Operations for the history connectors that already have a saved configuration. */
export function gitBackupOperations(): FeatureOperation[] {
  const ids = HISTORY_BACKUP_GROUPS.flatMap((group) => group.providerIds);
  return ids
    .map((id) => savedGitBackupOperation(id))
    .filter((operation) => operation.ok);
}

function savedRow(operation: FeatureOperation & { ok: true }): FeatureRequest {
  return {
    ok: true,
    providerId: operation.providerId,
    operation: operation.operation,
    fields: operation.action,
    secret: operation.secrets,
  };
}

/** Bind saved forge fields and tokens onto the backup sync. */
export function performGitBackup(
  operations: readonly FeatureOperation[] = gitBackupOperations(),
): FeatureRequest[] {
  const merged = new Map<string, FeatureRequest & { ok: true }>();
  for (const operation of operations) {
    if (operation.ok) {
      const row = savedRow(operation);
      if (row.ok) merged.set(row.providerId, row);
    }
  }
  for (const row of savedFeatureRequests(["backup_recovery"])) {
    if (row.ok) merged.set(row.providerId, row);
  }
  const uses = [...merged.values()].flatMap((row) => {
    const sent = dispatchFeatureCall(row);
    return sent.ok ? [sent] : [];
  });
  bindSavedGitBackup(
    uses.map((row) => ({
      providerId: row.providerId,
      operation: row.operation,
      fields: row.fields,
      secret: row.secret,
    })),
  );
  return uses.flatMap((row) => {
    const used = savedGitBackupUse(row.providerId);
    if (!used) return [];
    return [
      {
        ok: true as const,
        providerId: used.providerId,
        operation: used.operation,
        fields: used.fields,
        secret: used.secret,
      },
    ];
  });
}

export const capabilityRuntime: CapabilityRuntime = {
  capability: CAPABILITY,
  async activate(ctx) {
    const activation = createActivation(ctx, CAPABILITY);
    if (activation.disposed()) return activation.handle();

    activation.register("background-job", {
      id: BACKUP_OBSERVER_JOB,
      start: (signal) => {
        if (signal.aborted) return;
        // The saved operations are bound even when the network envelope
        // holds the observer. The observer itself stays behind that gate
        // (ADR 0135 §1, 0142).
        performGitBackup(gitBackupOperations());
        if (!backupEgressGate.allowed()) return;
        startVaultBackupObserver();
        signal.addEventListener("abort", stopVaultBackupObserver, {
          once: true,
        });
      },
    });
    // A dispose that never ran the job must still leave nothing behind, and
    // the observer's own `started` guard makes a second stop a no-op.
    activation.onDispose(stopVaultBackupObserver);

    return activation.handle();
  },
};
