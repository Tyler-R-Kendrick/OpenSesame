import { afterEach, beforeEach, expect, it } from "vitest";
import {
  readDeviceRows,
  readDeviceSecrets,
} from "../device-connector-records.js";
import { kvForgetAll } from "../kv.js";
import {
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import {
  assertTailscaleAppCurrent,
  forgetTailscaleApp,
  hydrateTailscaleApps,
  openTailscaleApp,
  readTailscaleApp,
  saveTailscaleApp,
} from "./store.js";
const config = {
  apiBase: "https://api.tailscale.com/",
  tailnet: "-",
  redirectUri: "https://operator.example/callback",
  name: "Operator deployment",
};
const app = {
  id: "generated-tailnet-app-id",
  name: config.name,
  clientSecret: "operator-private-app-secret-fixture",
  redirectURIs: [config.redirectUri],
  scopes: ["auth_keys:create:once"],
};
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
  await hydrateTailscaleApps();
});
afterEach(async () => {
  await fixture.close();
});
function tomb() {
  return vaultStore.getSnapshot().tomb;
}
function check() {
  if (vaultStore.getSnapshot().status !== "unlocked") throw new Error("locked");
}
it("keeps generated app secrets only in actual encrypted vault CredentialItems and cold reloads metadata references", async () => {
  const saved = await saveTailscaleApp(config, app, tomb(), check);
  expect(openTailscaleApp(saved, tomb())).toEqual(app);
  expect(JSON.stringify(readDeviceRows())).not.toContain(app.clientSecret);
  expect(JSON.stringify(readDeviceSecrets())).not.toContain(app.clientSecret);
  const item = vaultStore
    .getSnapshot()
    .items.find((entry) => entry.kind === "credential");
  expect(item).toMatchObject({
    kind: "credential",
    method: { type: "token", token: app.clientSecret },
  });
  kvForgetAll();
  await hydrateTailscaleApps();
  expect(readTailscaleApp(saved.connectionId)).toEqual(saved);
  expect(openTailscaleApp(saved, tomb())).toEqual(app);
  await vaultStore.flushPendingWrites();
  for (const value of fixture.files.values())
    expect(value).not.toContain(app.clientSecret);
});
it("refuses foreign target metadata, another vault and use after lock before opening a secret", async () => {
  const saved = await saveTailscaleApp(config, app, tomb(), check);
  expect(() =>
    openTailscaleApp(
      { ...saved, apiBase: "https://attacker.example/" },
      tomb(),
    ),
  ).toThrow();
  expect(() => openTailscaleApp(saved, "another-vault")).toThrow();
  vaultStore.lock();
  expect(() => openTailscaleApp(saved, saved.vaultTomb)).toThrow();
  await vaultStore.unlock(runtimePassword);
});
it("removes its metadata and exact referenced credential without preserving a usable handle", async () => {
  const saved = await saveTailscaleApp(config, app, tomb(), check);
  await forgetTailscaleApp(saved, tomb(), check);
  expect(readTailscaleApp(saved.connectionId)).toBeNull();
  expect(() => assertTailscaleAppCurrent(saved)).toThrow();
  expect(() => openTailscaleApp(saved, tomb())).toThrow();
});
it("does not publish metadata if the staged credential is edited before atomic commit", async () => {
  fixture.beforeAtomicWrite(async () => {
    fixture.beforeAtomicWrite();
    const current = vaultStore
      .getSnapshot()
      .items.find((entry) => entry.kind === "credential");
    if (
      !current ||
      current.kind !== "credential" ||
      current.method.type !== "token"
    )
      throw new Error("Expected token item");
    const edited = structuredClone(current);
    if (edited.method.type === "token")
      edited.method.token = "user-edited-token";
    await vaultStore.saveItem(edited);
  });
  await expect(saveTailscaleApp(config, app, tomb(), check)).rejects.toThrow();
  expect(readTailscaleApp()).toBeNull();
  expect(
    vaultStore
      .getSnapshot()
      .items.some(
        (item) =>
          item.kind === "credential" &&
          item.method.type === "token" &&
          item.method.token === "user-edited-token",
      ),
  ).toBe(true);
});
