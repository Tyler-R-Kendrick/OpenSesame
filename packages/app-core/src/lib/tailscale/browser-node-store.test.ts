import { afterEach, beforeEach, expect, it } from "vitest";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "../device-connector-records.js";
import {
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import {
  openBrowserNodeState,
  readBrowserNodeState,
  savedBrowserNodeConfiguration,
  writeBrowserNodeState,
} from "./browser-node-store.js";
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
const config = {
  hostname: "operator-browser",
  controlURL: "https://controlplane.tailscale.com",
};
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  await fixture.close();
});
function check() {
  if (vaultStore.getSnapshot().status !== "unlocked") throw new Error("locked");
}
it("keeps real SDK private state in a vault Token credential, seals it on disk and restores it only for the exact node", async () => {
  const tomb = vaultStore.getSnapshot().tomb;
  const initial = await openBrowserNodeState(config, tomb, check);
  expect(initial.state).toEqual({});
  const state = {
    _machinekey: "fixture-private-machine-key",
    _state: "fixture-private-node-key",
  };
  await writeBrowserNodeState(initial.record, {}, state, check);
  expect(readBrowserNodeState(initial.record)).toEqual(state);
  expect((await openBrowserNodeState(config, tomb, check)).state).toEqual(
    state,
  );
  expect(savedBrowserNodeConfiguration()).toEqual(config);
  for (const value of [
    JSON.stringify(readDeviceRows()),
    JSON.stringify(readDeviceSecrets()),
    ...fixture.files.values(),
  ])
    expect(value).not.toContain(state._machinekey);
  const credential = vaultStore
    .getSnapshot()
    .items.find((item) => item.kind === "credential");
  expect(credential).toMatchObject({
    kind: "credential",
    method: { type: "token", token: JSON.stringify(state) },
  });
  await expect(
    openBrowserNodeState(
      { ...config, controlURL: "https://different-control.example" },
      tomb,
      check,
    ),
  ).rejects.toThrow("different");
  await expect(
    openBrowserNodeState(config, "different-vault", check),
  ).rejects.toThrow();
  vaultStore.lock();
  expect(() => readBrowserNodeState(initial.record)).toThrow();
  await vaultStore.unlock(runtimePassword);
  expect(readBrowserNodeState(initial.record)).toEqual(state);
});
it("refuses private state replacement, retired credentials and cancelled writes", async () => {
  const initial = await openBrowserNodeState(
    config,
    vaultStore.getSnapshot().tomb,
    check,
  );
  await writeBrowserNodeState(initial.record, {}, { key: "first" }, check);
  await expect(
    writeBrowserNodeState(initial.record, {}, { key: "stale" }, check),
  ).rejects.toThrow("changed");
  await expect(
    writeBrowserNodeState(
      initial.record,
      { key: "first" },
      { key: "cancelled" },
      () => {
        throw new Error("cancelled");
      },
    ),
  ).rejects.toThrow("cancelled");
  expect(readBrowserNodeState(initial.record)).toEqual({ key: "first" });
  const item = vaultStore
    .getSnapshot()
    .items.find((entry) => entry.kind === "credential");
  if (!item) throw new Error("Expected node credential");
  await vaultStore.trashItem(item.id);
  expect(() => readBrowserNodeState(initial.record)).toThrow();
});
it("refuses an actual user credential edit queued ahead of the node's pending write", async () => {
  const initial = await openBrowserNodeState(
    config,
    vaultStore.getSnapshot().tomb,
    check,
  );
  const credential = vaultStore
    .getSnapshot()
    .items.find((item) => item.kind === "credential");
  if (
    !credential ||
    credential.kind !== "credential" ||
    credential.method.type !== "token"
  )
    throw new Error("Expected node token");
  const edited = structuredClone(credential);
  if (edited.method.type === "token")
    edited.method.token = JSON.stringify({ key: "person-edited" });
  const edit = vaultStore.saveItem(edited);
  const pending = writeBrowserNodeState(
    initial.record,
    {},
    { key: "node-update" },
    check,
  );
  await edit;
  await expect(pending).rejects.toThrow();
  expect(readBrowserNodeState(initial.record)).toEqual({
    key: "person-edited",
  });
  await expect(
    writeBrowserNodeState(initial.record, {}, { key: "stale" }, check),
  ).rejects.toThrow("changed");
});
it("does not publish a pending node-state write after lock or reopen it in another session", async () => {
  const initial = await openBrowserNodeState(
    config,
    vaultStore.getSnapshot().tomb,
    check,
  );
  const pending = writeBrowserNodeState(
    initial.record,
    {},
    { key: "locked-update" },
    check,
  );
  vaultStore.lock();
  await expect(pending).rejects.toThrow();
  await vaultStore.unlock(runtimePassword);
  expect(readBrowserNodeState(initial.record)).toEqual({});
});
