import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createNodeHost } from "../node/host.js";
import { readDeviceSecrets } from "./device-connector-records.js";
import {
  createDeviceConnection,
  sealDeviceCredential,
} from "./device-connectors.js";
import { runListedFeature } from "./feature-connector-operation.js";
import {
  getLocalGitRemote,
  rememberLocalGitRemote,
} from "./git-remote-local.js";
import { kvFlush, kvForgetAll } from "./kv.js";
import { vaultStore } from "./vault/store.js";
const PASSWORD = "genuine-member-owner-password";
const MEMBER_KEY = "member-production-api-key";
const GUEST_KEY = "guest-supplied-onboarding-key";
const DEVICE_KEYS = [
  "opensesame.device-connectors.v1",
  "opensesame.device-connector-secrets.v1",
];

it("ordinary guest cannot freshly reacquire member credentials while its own onboarding remains usable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ordinary-guest-principal-"));
  configureHost(createNodeHost({ stateDir: directory }));
  await vaultStore.create(PASSWORD);
  const member = await createDeviceConnection({
    providerId: "anthropic",
    displayName: "Member production",
  });
  await sealDeviceCredential(member.connectionId, MEMBER_KEY);
  const remote = await rememberLocalGitRemote({
    displayName: "Member private remote",
    configuration: {
      remote_url: "https://member.example.test/private",
      auth_mode: "https_token",
      username: "member-private-name",
      token: "member-real-git-token",
    },
  });
  await vaultStore.flushPendingWrites();
  await kvFlush();
  vaultStore.lock();
  try {
    await vaultStore.createGuest({ resume: false });
    const guest = await createDeviceConnection({
      providerId: "azure-openai",
      displayName: "Guest onboarding",
    });
    await sealDeviceCredential(guest.connectionId, GUEST_KEY);
    const guestRun = runListedFeature("azure-openai");
    expect(guestRun.ok && guestRun.secrets.credential).toBe(GUEST_KEY);
    const memberRun = runListedFeature("anthropic");
    expect({
      rawMemberKey: readDeviceSecrets()[member.connectionId]?.credential,
      freshOperationMemberKey: memberRun.ok
        ? memberRun.secrets.credential
        : undefined,
    }).toEqual({ rawMemberKey: undefined, freshOperationMemberKey: undefined });
    expect(getLocalGitRemote(remote.id)).toBeNull();
  } finally {
    vaultStore.lock();
    await kvFlush();
    kvForgetAll();
    await rm(directory, { recursive: true, force: true });
  }
});

it("independent ordinary guest hydration cannot expose a persisted member key under the real device at-rest key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fresh-guest-principal-"));
  // New actual modules and native IO ports: no substituted verdict, key or root.
  vi.resetModules();
  const firstHost = await import("../host.js");
  const firstNode = await import("../node/host.js");
  firstHost.configureHost(firstNode.createNodeHost({ stateDir: directory }));
  const firstKv = await import("./kv.js");
  const firstStore = (await import("./vault/store.js")).vaultStore;
  const firstDevice = await import("./device-connectors.js");
  await firstStore.create(PASSWORD);
  const member = await firstDevice.createDeviceConnection({
    providerId: "anthropic",
    displayName: "Member production",
  });
  await firstDevice.sealDeviceCredential(member.connectionId, MEMBER_KEY);
  await firstStore.flushPendingWrites();
  await firstKv.kvFlush();
  firstStore.lock();
  firstKv.kvForgetAll();
  vi.resetModules();
  const secondHost = await import("../host.js");
  const secondNode = await import("../node/host.js");
  secondHost.configureHost(secondNode.createNodeHost({ stateDir: directory }));
  const secondKv = await import("./kv.js");
  const secondStore = (await import("./vault/store.js")).vaultStore;
  const secondRecords = await import("./device-connector-records.js");
  const secondOperations = await import("./feature-connector-operation.js");
  try {
    const secondFiles = await import("./vfs.js");
    await secondKv.kvHydrate(
      ["header", "body", "index", "migrated.v1", "seal-bound.v1"].map((path) =>
        secondFiles.tombFileKey("personal", path),
      ),
    );
    secondStore.rehydrate();
    expect(secondStore.getSnapshot().status).toBe("locked");
    expect(secondRecords.readDeviceSecrets()).toEqual({});
    await secondStore.createGuest({ resume: false });
    await secondKv.kvHydrate(DEVICE_KEYS);
    const op = secondOperations.runListedFeature("anthropic");
    expect({
      persistedMemberKey:
        secondRecords.readDeviceSecrets()[member.connectionId]?.credential,
      hydratedOperationMemberKey: op.ok ? op.secrets.credential : undefined,
    }).toEqual({
      persistedMemberKey: undefined,
      hydratedOperationMemberKey: undefined,
    });
  } finally {
    secondStore.lock();
    await secondKv.kvFlush();
    secondKv.kvForgetAll();
    await rm(directory, { recursive: true, force: true });
  }
});
