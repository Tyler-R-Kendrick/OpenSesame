import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as records from "./device-connector-records.js";
import { encryptedRemoteContinuitySeed } from "./secret-backends/encrypted-remote-codec.js";
import { createEncryptedRemoteContinuity } from "./secret-backends/encrypted-remote-continuity.js";
import { deferred } from "./secret-backends/runtime.test-support.js";
import { runtimeFixture } from "./secret-backends/runtime.test-support.js";
import {
  assertVaultCredentials,
  readVaultCredentials,
  stageVaultCredentials,
  vaultCredentialField,
} from "./vault-credential-custody.js";
import { vaultStore } from "./vault/store.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  await fixture.close();
});
const identity = {
  objectUrl: "https://object.example/inventory.json",
  storeId: "36f746a2-8770-4b4a-b4b1-d0cc95cc225a",
};
const key = Buffer.alloc(32, 31).toString("base64");
function input(metadata = [encryptedRemoteContinuitySeed(identity)]) {
  return {
    name: "Inventory",
    targetBinding: "fixture-owned-target",
    fields: [
      { field: "encryptionKey", label: "Encryption key", value: key, metadata },
    ],
  };
}
it("stages copied protocol metadata with the exact vault Token before its immutable publication capture", async () => {
  const proposed = input();
  const staged = await stageVaultCredentials(
    proposed,
    vaultStore.getSnapshot().tomb,
    () => {},
  );
  proposed.fields[0].metadata[0].value = "caller changed its input";
  assertVaultCredentials(staged, vaultStore.getSnapshot().tomb, () => {});
  const saved = readVaultCredentials(
    staged.reference,
    proposed.targetBinding,
    ["encryptionKey"],
    vaultStore.getSnapshot().tomb,
  );
  expect(saved.fields.get("encryptionKey")).toBe(key);
  expect(saved.items.map(vaultCredentialField)).toEqual(["encryptionKey"]);
  expect(saved.items[0]?.fields).toContainEqual(
    encryptedRemoteContinuitySeed(identity),
  );
  expect([...fixture.files.values()].some((bytes) => bytes.includes(key))).toBe(
    false,
  );
});
it.each(["binding", "duplicate"])(
  "refuses %s metadata before any credential is persisted",
  async (mode) => {
    const metadata = encryptedRemoteContinuitySeed(identity);
    const proposed =
      mode === "binding"
        ? input([{ ...metadata, id: "opensesame-integration-binding" }])
        : input([metadata, { ...metadata }]);
    await expect(
      stageVaultCredentials(proposed, vaultStore.getSnapshot().tomb, () => {}),
    ).rejects.toMatchObject({ code: "invalid_reference" });
    expect(
      vaultStore
        .getSnapshot()
        .items.filter((item) => item.kind === "credential"),
    ).toEqual([]);
  },
);
it("rejects publication after the actual staged metadata is edited", async () => {
  const staged = await stageVaultCredentials(
    input(),
    vaultStore.getSnapshot().tomb,
    () => {},
  );
  const item = staged.items[0];
  if (!item) throw new Error("Missing staged credential");
  await vaultStore.saveItem({
    ...item,
    fields: item.fields.map((field) =>
      field.id === "opensesame-integration-binding"
        ? field
        : { ...field, value: "edited checkpoint" },
    ),
  });
  expect(() =>
    assertVaultCredentials(staged, vaultStore.getSnapshot().tomb, () => {}),
  ).toThrow();
});

it("serializes a real checkpoint vault commit after the existing connector publication lock", async () => {
  const staged = await stageVaultCredentials(
    input(),
    vaultStore.getSnapshot().tomb,
    () => {},
  );
  const read = () => {
    const item = readVaultCredentials(
      staged.reference,
      input().targetBinding,
      ["encryptionKey"],
      vaultStore.getSnapshot().tomb,
    ).items[0];
    if (!item) throw new Error("Missing original key");
    return item;
  };
  const owner = new AbortController();
  const point = createEncryptedRemoteContinuity(read, {
    fetch: fixture.fetcher,
    signal: owner.signal,
    assertCurrent: () => owner.signal.throwIfAborted(),
  });
  const entered = deferred<void>();
  const resume = deferred<void>();
  const original = records.withDeviceConfigurationLock;
  const held = original(async () => {
    entered.resolve();
    await resume.promise;
  });
  await entered.promise;
  const queued = deferred<void>();
  const locking = vi
    .spyOn(records, "withDeviceConfigurationLock")
    .mockImplementation(<T>(work: () => Promise<T>) => {
      queued.resolve();
      return original(work);
    });
  const observing = point.observe(
    identity,
    1,
    "Already authenticated fixture ciphertext",
  );
  await queued.promise;
  try {
    expect(read().fields).toContainEqual(
      encryptedRemoteContinuitySeed(identity),
    );
  } finally {
    resume.resolve();
  }
  await held;
  await observing;
  owner.abort();
  locking.mockRestore();
  expect(read().fields).not.toContainEqual(
    encryptedRemoteContinuitySeed(identity),
  );
});
