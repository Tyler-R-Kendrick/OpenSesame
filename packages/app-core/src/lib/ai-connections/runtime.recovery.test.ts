import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDeviceRows } from "../device-connector-records.js";
import { createProject, setActiveProject } from "../projects.js";
import {
  runtimeFixture,
  runtimePassword,
} from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import { aiConnectionDraft } from "./presets.js";
import {
  deleteAiConnection,
  performSavedAiInference,
  saveAiConnection,
} from "./runtime.js";
import { readAiConnection } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
let release = () => {};
const fetcher = vi.fn(async () =>
  Response.json({ choices: [{ message: { content: "Verified" } }] }),
);
beforeEach(async () => {
  fixture = await runtimeFixture();
  fetcher.mockClear();
  release = bindAiConnectionTransport({
    fetch: fetcher,
    signal: new AbortController().signal,
    assertCurrent() {},
  });
});
afterEach(async () => {
  release();
  await fixture.close();
});
async function saved() {
  return saveAiConnection({
    ...aiConnectionDraft("byo-ai"),
    baseUrl: "https://models.example/v1",
    model: "fixture-model",
    apiKey: "fixture-ai-custody-removal-key",
  });
}
function token() {
  const item = vaultStore.getSnapshot().items[0];
  if (item?.kind !== "credential" || item.method.type !== "token")
    throw new Error("Expected the integration token");
  return structuredClone(item);
}

it.each(["missing", "edited", "invalid binding"])(
  "removes dead AI metadata after %s custody while refusing inference and preserving the item",
  async (change) => {
    const connection = await saved();
    const item = token();
    if (change === "missing") await vaultStore.trashItem(item.id);
    else {
      if (change === "edited" && item.method.type === "token")
        item.method.token = "user-edited-fixture-key";
      else item.fields = [];
      await vaultStore.saveItem(item);
    }
    const expected = structuredClone(vaultStore.getSnapshot().items);
    const calls = fetcher.mock.calls.length;
    await expect(
      performSavedAiInference(connection.connectionId, {
        model: "fixture-model",
        messages: [{ role: "user", content: "Do not dispatch" }],
      }),
    ).rejects.toThrow();
    expect(fetcher.mock.calls).toHaveLength(calls);
    await expect(
      deleteAiConnection(connection.connectionId),
    ).resolves.toBeUndefined();
    expect(readAiConnection(connection.connectionId)).toBeNull();
    expect(vaultStore.getSnapshot().items).toEqual(expected);
  },
);

it("preserves a real user edit during metadata removal rather than deleting the newly edited token", async () => {
  const connection = await saved();
  const item = token();
  if (item.method.type === "token")
    item.method.token = "queued-user-fixture-key";
  fixture.beforeAtomicWrite(async () => {
    fixture.beforeAtomicWrite();
    await vaultStore.saveItem(item);
  });
  await expect(
    deleteAiConnection(connection.connectionId),
  ).resolves.toBeUndefined();
  expect(readAiConnection(connection.connectionId)).toBeNull();
  expect(token().method).toEqual(item.method);
});

it("does not remove dangling metadata after a vault lock during durable publication", async () => {
  const connection = await saved();
  await vaultStore.trashItem(token().id);
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  fixture.beforeAtomicWrite(async () => {
    fixture.beforeAtomicWrite();
    vaultStore.lock();
  });
  await expect(deleteAiConnection(connection.connectionId)).rejects.toThrow();
  await vaultStore.unlock(runtimePassword);
  expect(readAiConnection(connection.connectionId)).not.toBeNull();
  expect(readDeviceRows()).toHaveLength(1);
});

it("does not treat missing credentials as permission to remove another vault's metadata", async () => {
  const connection = await saved();
  await vaultStore.trashItem(token().id);
  await vaultStore.flushPendingWrites();
  await vfsFlush();
  const project = await createProject("AI credential recovery isolation");
  await setActiveProject(project.id);
  vaultStore.loadActiveProjectScope();
  await vaultStore.create("a different actual vault fixture password");
  await expect(deleteAiConnection(connection.connectionId)).rejects.toThrow(
    /vault/,
  );
  expect(readAiConnection(connection.connectionId)).not.toBeNull();
  await setActiveProject("personal");
  vaultStore.loadActiveProjectScope();
});
