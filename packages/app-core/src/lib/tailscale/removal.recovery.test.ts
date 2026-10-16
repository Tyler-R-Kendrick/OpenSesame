import { afterEach, beforeEach, expect, it } from "vitest";
import { readDeviceRows } from "../device-connector-records.js";
import { createProject, setActiveProject } from "../projects.js";
import {
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import {
  forgetBrowserNodeState,
  openBrowserNodeState,
  readBrowserNodeState,
  savedBrowserNodeConfiguration,
} from "./browser-node-store.js";
import {
  forgetTailscaleApp,
  openTailscaleApp,
  readTailscaleApp,
  saveTailscaleApp,
} from "./store.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  await fixture.close();
});
function check() {
  if (vaultStore.getSnapshot().status !== "unlocked") throw new Error("locked");
}
function token() {
  const item = vaultStore.getSnapshot().items[0];
  if (item?.kind !== "credential" || item.method.type !== "token")
    throw new Error("Expected the integration token");
  return structuredClone(item);
}
async function saved(kind: "app" | "node") {
  const tomb = vaultStore.getSnapshot().tomb;
  if (kind === "node") {
    const { record } = await openBrowserNodeState(
      {
        hostname: "fixture-browser",
        controlURL: "https://controlplane.tailscale.com",
      },
      tomb,
      check,
    );
    return {
      forget: () => forgetBrowserNodeState(tomb, check),
      usable: () => readBrowserNodeState(record),
      metadata: savedBrowserNodeConfiguration,
    };
  }
  const config = {
    apiBase: "https://api.tailscale.com/",
    tailnet: "-",
    redirectUri: "https://operator.example/callback",
    name: "Fixture app",
  };
  const app = await saveTailscaleApp(
    config,
    {
      id: "fixture-app-id",
      name: config.name,
      clientSecret: "fixture-tailscale-removal-secret",
      redirectURIs: [config.redirectUri],
      scopes: ["auth_keys:create:once"],
    },
    tomb,
    check,
  );
  return {
    forget: () => forgetTailscaleApp(app, tomb, check),
    usable: () => openTailscaleApp(app, tomb),
    metadata: () => readTailscaleApp(app.connectionId),
  };
}

for (const kind of ["app", "node"] as const) {
  it.each(["missing", "invalid binding"])(
    `removes ${kind} metadata after %s custody without reopening or destroying the item`,
    async (change) => {
      const connection = await saved(kind);
      const item = token();
      if (change === "missing") await vaultStore.trashItem(item.id);
      else {
        item.fields = [];
        await vaultStore.saveItem(item);
      }
      const expected = structuredClone(vaultStore.getSnapshot().items);
      expect(connection.usable).toThrow();
      await expect(connection.forget()).resolves.toBeUndefined();
      expect(connection.metadata()).toBeNull();
      expect(connection.usable).toThrow();
      expect(vaultStore.getSnapshot().items).toEqual(expected);
    },
  );

  it(`retains a user edit queued during ${kind} metadata removal and revokes the saved handle`, async () => {
    const connection = await saved(kind);
    const item = token();
    if (item.method.type === "token")
      item.method.token = "queued-user-fixture-token";
    fixture.beforeAtomicWrite(async () => {
      fixture.beforeAtomicWrite();
      await vaultStore.saveItem(item);
    });
    await expect(connection.forget()).resolves.toBeUndefined();
    expect(connection.metadata()).toBeNull();
    expect(connection.usable).toThrow();
    expect(token().method).toEqual(item.method);
  });

  it(`refuses ${kind} metadata removal if its owning vault locks during durable publication`, async () => {
    const connection = await saved(kind);
    await vaultStore.trashItem(token().id);
    await vaultStore.flushPendingWrites();
    await vfsFlush();
    fixture.beforeAtomicWrite(async () => {
      fixture.beforeAtomicWrite();
      vaultStore.lock();
    });
    await expect(connection.forget()).rejects.toThrow();
    await vaultStore.unlock(runtimePassword);
    expect(connection.metadata()).not.toBeNull();
    expect(readDeviceRows()).toHaveLength(1);
  });

  it(`refuses dangling ${kind} removal from a different unlocked vault`, async () => {
    const connection = await saved(kind);
    await vaultStore.trashItem(token().id);
    await vaultStore.flushPendingWrites();
    await vfsFlush();
    const project = await createProject(
      "Tailscale credential recovery isolation",
    );
    await setActiveProject(project.id);
    vaultStore.loadActiveProjectScope();
    await vaultStore.create("different actual vault fixture password");
    await expect(connection.forget()).rejects.toThrow(/vault/);
    expect(readDeviceRows()).toHaveLength(1);
    await setActiveProject("personal");
    vaultStore.loadActiveProjectScope();
  });
}
