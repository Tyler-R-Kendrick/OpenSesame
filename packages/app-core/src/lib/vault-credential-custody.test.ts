import { afterEach, beforeEach, expect, it } from "vitest";
import { runtimeFixture } from "./secret-backends/runtime.test-support.js";
import {
  assertVaultCredentials,
  discardVaultCredentials,
  readVaultCredentials,
  stageVaultCredentials,
} from "./vault-credential-custody.js";
import { vaultStore } from "./vault/store.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  await fixture.close();
});
const input = {
  name: "Generic integration",
  targetBinding: JSON.stringify([
    "integration-fixture",
    "https://service.example.com",
    "workspace",
  ]),
  fields: [
    { field: "apiKey", label: "AI API key", value: "api-key-fixture" },
    {
      field: "clientSecret",
      label: "OAuth app secret",
      value: "client-secret-fixture",
    },
  ],
};
it("stores independent allowed fields in the actual vault and refuses a different target or field contract", async () => {
  const tomb = vaultStore.getSnapshot().tomb;
  const capture = await stageVaultCredentials(input, tomb, () => {});
  expect(capture.items.map((item) => item.name)).toEqual([
    "AI API key · Generic integration",
    "OAuth app secret · Generic integration",
  ]);
  const read = readVaultCredentials(
    capture.reference,
    input.targetBinding,
    ["apiKey", "clientSecret"],
    tomb,
  );
  expect(read.fields.get("apiKey")).toBe("api-key-fixture");
  expect(read.fields.get("clientSecret")).toBe("client-secret-fixture");
  expect(() =>
    readVaultCredentials(
      capture.reference,
      "another-target",
      ["apiKey", "clientSecret"],
      tomb,
    ),
  ).toThrow();
  expect(() =>
    readVaultCredentials(
      capture.reference,
      input.targetBinding,
      ["clientSecret"],
      tomb,
    ),
  ).toThrow();
  expect(() => assertVaultCredentials(capture, tomb, () => {})).not.toThrow();
  await discardVaultCredentials(capture, tomb, () => {});
  expect(vaultStore.getSnapshot().items).toEqual([]);
});
it("captures immutable item text and refuses to publish or clean up a later user edit", async () => {
  const tomb = vaultStore.getSnapshot().tomb;
  const capture = await stageVaultCredentials(input, tomb, () => {});
  const item = capture.items[0];
  if (!item) throw new Error("Expected staged token");
  await vaultStore.saveItem({ ...item, name: "Owner renamed this credential" });
  expect(capture.items[0]?.name).toBe("AI API key · Generic integration");
  expect(() => assertVaultCredentials(capture, tomb, () => {})).toThrow();
  await expect(
    discardVaultCredentials(capture, tomb, () => {}),
  ).rejects.toMatchObject({ code: "item_changed" });
  expect(vaultStore.getSnapshot().items).toHaveLength(2);
});
it("supports explicit no-auth configurations while refusing duplicate fields and guest custody", async () => {
  const tomb = vaultStore.getSnapshot().tomb;
  const empty = await stageVaultCredentials(
    { ...input, fields: [] },
    tomb,
    () => {},
  );
  expect(empty.items).toEqual([]);
  expect(
    readVaultCredentials(empty.reference, input.targetBinding, [], tomb).fields
      .size,
  ).toBe(0);
  await expect(
    stageVaultCredentials(
      {
        ...input,
        fields: [input.fields[0], input.fields[0]].filter(
          (field) => field !== undefined,
        ),
      },
      tomb,
      () => {},
    ),
  ).rejects.toMatchObject({ code: "invalid_reference" });
  expect(vaultStore.getSnapshot().items).toEqual([]);
  vaultStore.lock();
  await vaultStore.createGuest();
  await expect(
    stageVaultCredentials(input, vaultStore.getSnapshot().tomb, () => {}),
  ).rejects.toMatchObject({ code: "locked" });
  expect(vaultStore.getSnapshot().items).toEqual([]);
});
