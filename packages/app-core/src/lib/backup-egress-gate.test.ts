/** @vitest-environment jsdom */
import type { NetworkPolicy } from "@opensesame/capability-composition";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupEgressGate, backupOriginAllowed } from "./backup-egress-gate.js";
import {
  clearLocalBackupTarget,
  writeLocalBackupTarget,
} from "./backup-target-local.js";
import { getBackupStatus, setBackupTargetEnabled } from "./backup.js";
import {
  stopVaultBackupObserver,
  vaultBackupObserverSeams,
} from "./vault-backup-observer.js";
import { vaultBackupSyncSeams } from "./vault-backup-sync.js";

const originalSync = { ...vaultBackupSyncSeams };

/** The plan as the gate reads it: git backup running or not, and its network. */
function plan(
  running: boolean,
  externalServices: NetworkPolicy["externalServices"],
  allowedServiceOrigins: string[] = [],
): void {
  vi.spyOn(backupEgressGate, "running").mockReturnValue(running);
  vi.spyOn(backupEgressGate, "network").mockReturnValue({
    externalServices,
    allowedServiceOrigins,
  });
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

function stubPush() {
  const putContents = vi.fn(async () => ({ commitSha: "x" }));
  Object.assign(vaultBackupSyncSeams, {
    sealedEnvelopeJson: () => "{}",
    resolveCredentials: () => ({ appId: "1", pem: "pem" }),
    putContents,
  });
  return putContents;
}

describe("git backup's calls hold inside the operator's policy (ADR 0142)", () => {
  afterEach(() => {
    stopVaultBackupObserver();
    clearLocalBackupTarget();
    Object.assign(vaultBackupSyncSeams, originalSync);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a Settings tile reading the status starts nothing while external services are denied", async () => {
    plan(true, "deny");
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
    const putContents = stubPush();
    plan(true, "deny");
    await vaultBackupObserverSeams.runSync("vault");
    await vaultBackupObserverSeams.runSync("webhook");
    expect(putContents).not.toHaveBeenCalled();
    // A person asking for it by hand is not an automatic call.
    await vaultBackupObserverSeams.runSync("manual");
    expect(putContents).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    plan(true, "allow");
    await vaultBackupObserverSeams.runSync("vault");
    expect(putContents).toHaveBeenCalledTimes(2);
  });

  it("withdrawn by the operator, it makes no call at all — a manual one included", async () => {
    enabledGithubTarget();
    const putContents = stubPush();
    plan(false, "allow");
    await vaultBackupObserverSeams.runSync("manual");
    await vaultBackupObserverSeams.runSync("vault");
    expect(putContents).not.toHaveBeenCalled();
    expect(backupOriginAllowed("https://relay.example")).toBe(false);
  });

  it("starts the observer once the plan allows external services", async () => {
    plan(true, "allow");
    enabledGithubTarget();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const interval = vi.spyOn(globalThis, "setInterval");
    await getBackupStatus("github");
    expect(interval).toHaveBeenCalledTimes(1);
  });

  it("a non-empty allowedServiceOrigins is an allowlist for every backup call", () => {
    plan(true, "allow", ["https://relay.example"]);
    expect(
      backupOriginAllowed("https://relay.example/api/git-backup/put"),
    ).toBe(true);
    expect(backupOriginAllowed("https://elsewhere.example/api")).toBe(false);
    expect(backupOriginAllowed("not a url")).toBe(false);
    vi.restoreAllMocks();
    plan(true, "allow", []);
    expect(backupOriginAllowed("https://elsewhere.example/api")).toBe(true);
  });
});
