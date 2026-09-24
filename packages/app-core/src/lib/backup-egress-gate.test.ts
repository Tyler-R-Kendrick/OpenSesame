/** @vitest-environment jsdom */
import type { EffectivePlan } from "@opensesame/capability-composition";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import { getBackupStatus, setBackupTargetEnabled } from "./backup.js";
import type { CompositionSnapshot } from "./capabilities/store-types.js";
import { compositionStore } from "./capabilities/store.js";
import {
  stopVaultBackupObserver,
  vaultBackupObserverSeams,
} from "./vault-backup-observer.js";
import { vaultBackupSyncSeams } from "./vault-backup-sync.js";

const originalSync = { ...vaultBackupSyncSeams };

/** The composition store's snapshot with only the plan's network set. */
function planNetwork(externalServices: "allow" | "deny"): void {
  const real = compositionStore.getSnapshot();
  vi.spyOn(compositionStore, "getSnapshot").mockReturnValue({
    ...real,
    plan: {
      network: { externalServices, allowedServiceOrigins: [] },
      // SAFETY: the gate reads `plan.network` alone; the rest of the plan is
      // not consulted on this path, so a partial plan cannot mislead it.
    } as unknown as EffectivePlan,
  } satisfies CompositionSnapshot);
}

function enabledGithubTarget(): void {
  writeLocalBackupTarget({
    kind: "github_app",
    providerId: "github",
    connectionId: null,
    integrationId: "app-1",
    installationId: "777",
    owner: "octo",
    repo: "vault",
    branch: "main",
    enabled: true,
    status: "ready",
    lastCommitSha: null,
    lastSyncedAt: null,
    lastError: null,
    config: null,
    pendingEvents: 0,
  });
}

describe("git backup's automatic calls hold inside the network envelope (ADR 0138)", () => {
  afterEach(() => {
    stopVaultBackupObserver();
    clearLocalBackupTarget();
    Object.assign(vaultBackupSyncSeams, originalSync);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a Settings tile reading the status starts nothing while external services are denied", async () => {
    planNetwork("deny");
    enabledGithubTarget();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const interval = vi.spyOn(globalThis, "setInterval");
    await getBackupStatus("github");
    await setBackupTargetEnabled(true, "github");
    expect(interval).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a vault mutation pushes nothing while denied, and a manual sync still does", async () => {
    enabledGithubTarget();
    const putContents = vi.fn(async () => ({ commitSha: "x" }));
    Object.assign(vaultBackupSyncSeams, {
      sealedEnvelopeJson: () => "{}",
      resolveCredentials: () => ({ appId: "1", pem: "pem" }),
      putContents,
    });
    planNetwork("deny");
    await vaultBackupObserverSeams.runSync("vault");
    await vaultBackupObserverSeams.runSync("webhook");
    expect(putContents).not.toHaveBeenCalled();
    // A person asking for it by hand is not an automatic call.
    await vaultBackupObserverSeams.runSync("manual");
    expect(putContents).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    planNetwork("allow");
    await vaultBackupObserverSeams.runSync("vault");
    expect(putContents).toHaveBeenCalledTimes(2);
  });

  it("starts the observer once the plan allows external services", async () => {
    planNetwork("allow");
    enabledGithubTarget();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const interval = vi.spyOn(globalThis, "setInterval");
    await getBackupStatus("github");
    expect(interval).toHaveBeenCalledTimes(1);
  });
});
