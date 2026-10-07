/** @vitest-environment durable-page */
import { File as NodeFile } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureHost, host } from "@opensesame/app-core/host.js";
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import {
  compositionStore,
  storeSeams,
} from "@opensesame/app-core/lib/capabilities/store.js";
import { requiresFreshOwnerAuthentication } from "@opensesame/app-core/lib/decoy-session.js";
import { kvFlush, kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import {
  activeProject,
  createProject,
  setActiveProject,
} from "@opensesame/app-core/lib/projects.js";
import {
  enrollRetiredCredential,
  retiredCredentialOwnerSeams,
} from "@opensesame/app-core/lib/retired-credentials/index.js";
import { unlockWithRetiredCredentialGate } from "@opensesame/app-core/lib/retired-credentials/unlock.js";
import {
  VaultStore,
  vaultStore,
} from "@opensesame/app-core/lib/vault/store.js";
import { lockAllTombs, vfsFlush } from "@opensesame/app-core/lib/vfs.js";
import { createNodeHost } from "@opensesame/app-core/node/host.js";
import { expect, it, vi } from "vitest";
import { distributionFromOwnership } from "../lib/capabilities/ownership.js";
import { bootCore } from "./boot.js";

it("boots the original project unlock from durable storage without revealing its name", async () => {
  // The real Node disk adapter needs the runtime File.text API absent in jsdom.
  vi.stubGlobal("File", NodeFile);
  const previousHost = host();
  const ownerCheck = retiredCredentialOwnerSeams.isRealOwner;
  const directory = await mkdtemp(join(tmpdir(), "os-page-owner-recovery-"));
  const disk = createNodeHost({ stateDir: directory });
  const pageHost = {
    ...previousHost,
    originFiles: disk.originFiles,
    locks: disk.locks,
  };
  configureHost(pageHost);
  kvForgetAll();
  storeSeams.catalog = async () => CAPABILITY_CATALOG;
  storeSeams.distribution = async () => distributionFromOwnership("selective");
  storeSeams.locks = () => undefined;
  compositionStore.resetForTest();
  try {
    const unrelated = new VaultStore();
    await unrelated.create("unrelated owner password");
    unrelated.lock();
    const project = await createProject("Private owner project name");
    await setActiveProject(project.id);
    vaultStore.loadActiveProjectScope();
    await vaultStore.create("original project owner password");
    retiredCredentialOwnerSeams.isRealOwner = (tomb) =>
      tomb === vaultStore.activeTomb() &&
      vaultStore.getSnapshot().status === "unlocked" &&
      !vaultStore.getSnapshot().guest;
    await enrollRetiredCredential({
      tomb: project.id,
      currentPassword: "original project owner password",
      retiredPassword: "retired project owner password",
      response: "synthetic_decoy",
      acknowledgePasswordVerifierRisk: true,
    });
    await vaultStore.flushPendingWrites();
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(
      vaultStore,
      "retired project owner password",
    );
    vaultStore.lock();
    await vfsFlush();
    await kvFlush();
    lockAllTombs();
    kvForgetAll();
    // Normal host/module activation retains this tab's actual sealed session store.
    configureHost({ ...pageHost });
    compositionStore.resetForTest();
    const boot = await bootCore();
    boot.stopWatching();
    expect(activeProject().name).not.toBe("Private owner project name");
    expect(vaultStore.activeTomb()).toBe(project.id);
    expect(vaultStore.getSnapshot().status).toBe("locked");
    expect(requiresFreshOwnerAuthentication()).toBe(true);
    await expect(
      unrelated.unlock("unrelated owner password"),
    ).rejects.toThrow();
    expect(requiresFreshOwnerAuthentication()).toBe(true);
    await unlockWithRetiredCredentialGate(
      vaultStore,
      "original project owner password",
    );
    expect(requiresFreshOwnerAuthentication()).toBe(false);
    expect(vaultStore.getSnapshot()).toMatchObject({
      status: "unlocked",
      guest: false,
    });
    expect(vaultStore.activeTomb()).toBe(project.id);
  } finally {
    vaultStore.lock();
    await vfsFlush();
    await kvFlush();
    lockAllTombs();
    kvForgetAll();
    configureHost(previousHost);
    retiredCredentialOwnerSeams.isRealOwner = ownerCheck;
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllGlobals();
  }
}, 30_000);
