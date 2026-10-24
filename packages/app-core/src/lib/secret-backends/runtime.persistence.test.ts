import { afterEach, beforeEach, expect, it } from "vitest";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "../device-connector-records.js";
import {
  deviceConnection,
  revokeDeviceConnection,
} from "../device-connectors.js";
import { kvForgetAll } from "../kv.js";
import { createProject, setActiveProject } from "../projects.js";
import { vaultStore } from "../vault/store.js";
import {
  connectSecretBackend,
  deleteSecretBackendConnection,
  probeSecretBackend,
  saveSecretBackendConnection,
} from "./runtime.js";
import {
  deferred,
  ledgerFile,
  remoteDraft,
  runtimeFixture,
  runtimePassword,
} from "./runtime.test-support.js";
import {
  listSecretBackendConnections,
  readSecretBackendConnection,
  secretBackendConnectionVault,
  secretBackendRuntimeConfiguration,
} from "./store.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  await fixture.close();
});

it("persists a sealed scoped configuration, exposes no token publicly, reloads cold and connects through the real adapter", async () => {
  const draft = remoteDraft();
  const saved = await saveSecretBackendConnection(draft);
  expect(saved.status).toBe("pending");
  expect(fixture.fetcher).not.toHaveBeenCalled();
  expect(secretBackendConnectionVault(saved.connectionId)).toBe(
    vaultStore.getSnapshot().tomb,
  );
  expect(readSecretBackendConnection(saved.connectionId)?.token).toBe("");
  expect(JSON.stringify(readDeviceRows())).not.toContain(draft.token);
  const sealed = fixture.files.get(ledgerFile);
  expect(sealed).toBeTruthy();
  expect(sealed).not.toContain(draft.token);
  kvForgetAll();
  expect(listSecretBackendConnections()).toEqual([]);
  const open = await connectSecretBackend(saved.connectionId);
  expect(await open.backend.listItems(open.session)).toEqual([]);
  expect(fixture.fetcher).toHaveBeenCalled();
  expect(deviceConnection(saved.connectionId)?.status).toBe("active");
  await revokeDeviceConnection(saved.connectionId);
  expect(readSecretBackendConnection(saved.connectionId)).toBeNull();
  await expect(open.backend.listItems(open.session)).rejects.toMatchObject({
    code: "stale",
  });
});
it("blank credentials survive an unchanged target edit but cannot be spent at another URL or vault", async () => {
  const draft = remoteDraft();
  const saved = await saveSecretBackendConnection(draft);
  const publicDraft = readSecretBackendConnection(saved.connectionId);
  if (!publicDraft) throw new Error("Expected saved public config");
  await saveSecretBackendConnection(
    { ...publicDraft, name: "Renamed" },
    saved.connectionId,
  );
  expect(readDeviceSecrets()[saved.connectionId]?.token).toBeUndefined();
  expect(
    secretBackendRuntimeConfiguration(
      saved.connectionId,
      vaultStore.getSnapshot().tomb,
    )?.token,
  ).toBe(draft.token);
  for (const change of [
    { baseUrl: "https://other.example.com" },
    { vaultId: "other-vault" },
    { baseUrl: `${draft.baseUrl}/` },
  ]) {
    await expect(
      saveSecretBackendConnection(
        { ...publicDraft, ...change },
        saved.connectionId,
      ),
    ).rejects.toMatchObject({ code: "configuration" });
  }
  expect(
    secretBackendRuntimeConfiguration(saved.connectionId, "different-vault"),
  ).toBeNull();
  expect(readDeviceSecrets()[saved.connectionId]?.token).toBeUndefined();
  expect(
    secretBackendRuntimeConfiguration(
      saved.connectionId,
      vaultStore.getSnapshot().tomb,
    )?.token,
  ).toBe(draft.token);
});
it("a failed disk write retains the previous sealed record and a probe never creates a saved connection", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const previous = fixture.files.get(ledgerFile);
  fixture.beforeAtomicWrite(async () => {
    throw new Error("disk unavailable");
  });
  await expect(
    saveSecretBackendConnection(
      { ...remoteDraft(), name: "Failed edit" },
      saved.connectionId,
    ),
  ).rejects.toThrow("disk unavailable");
  expect(fixture.files.get(ledgerFile)).toBe(previous);
  expect(readSecretBackendConnection(saved.connectionId)?.name).toBe(
    remoteDraft().name,
  );
  fixture.beforeAtomicWrite();
  await probeSecretBackend(remoteDraft());
  expect(listSecretBackendConnections()).toHaveLength(1);
  expect(deviceConnection(saved.connectionId)?.status).toBe("pending");
});
it.each(["edit", "delete"])(
  "locking during a staged encrypted %s aborts its durable publication",
  async (action) => {
    const saved = await saveSecretBackendConnection(remoteDraft());
    const previous = fixture.files.get(ledgerFile);
    const entered = deferred<void>();
    const resume = deferred<void>();
    fixture.beforeAtomicWrite(async () => {
      entered.resolve();
      await resume.promise;
    });
    const write =
      action === "delete"
        ? deleteSecretBackendConnection(saved.connectionId)
        : saveSecretBackendConnection(
            { ...remoteDraft(), name: "Late edit" },
            saved.connectionId,
          );
    const failure = expect(write).rejects.toMatchObject({ code: "stale" });
    await entered.promise;
    vaultStore.lock();
    resume.resolve();
    await failure;
    expect(fixture.files.get(ledgerFile)).toBe(previous);
    expect(readSecretBackendConnection(saved.connectionId)?.name).toBe(
      remoteDraft().name,
    );
  },
);
it("saved private credentials cannot be spent, edited, probed or removed from a guest vault", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  vaultStore.lock();
  await vaultStore.createGuest();
  fixture.fetcher.mockClear();
  await expect(connectSecretBackend(saved.connectionId)).rejects.toMatchObject({
    code: "locked",
  });
  await expect(
    probeSecretBackend(remoteDraft(), saved.connectionId),
  ).rejects.toMatchObject({ code: "locked" });
  await expect(
    deleteSecretBackendConnection(saved.connectionId),
  ).rejects.toMatchObject({ code: "locked" });
  await expect(
    saveSecretBackendConnection(remoteDraft(), saved.connectionId),
  ).rejects.toMatchObject({ code: "locked" });
  expect(fixture.fetcher).not.toHaveBeenCalled();
  vaultStore.lock();
  vaultStore.loadActiveProjectScope();
  await vaultStore.unlock(runtimePassword);
  const open = await connectSecretBackend(saved.connectionId);
  await open.backend.disconnect(open.session);
});
it("a separate real project vault cannot borrow another vault's saved credentials", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const owner = vaultStore.getSnapshot().tomb;
  const project = await createProject("Separate real vault");
  await setActiveProject(project.id);
  vaultStore.loadActiveProjectScope();
  await vaultStore.create("different project vault password fixture");
  expect(vaultStore.getSnapshot()).toMatchObject({
    status: "unlocked",
    guest: false,
    tomb: project.id,
  });
  fixture.fetcher.mockClear();
  await expect(connectSecretBackend(saved.connectionId)).rejects.toMatchObject({
    code: "stale",
  });
  await expect(
    deleteSecretBackendConnection(saved.connectionId),
  ).rejects.toMatchObject({ code: "stale" });
  expect(
    secretBackendRuntimeConfiguration(saved.connectionId, project.id),
  ).toBeNull();
  expect(secretBackendConnectionVault(saved.connectionId)).toBe(owner);
  expect(fixture.fetcher).not.toHaveBeenCalled();
  await setActiveProject("personal");
  vaultStore.loadActiveProjectScope();
});
