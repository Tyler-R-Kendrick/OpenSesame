import { createCredential } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import {
  readDeviceRows,
  readDeviceSecrets,
  updateDeviceConfigurationDurable,
} from "../device-connector-records.js";
import { kvGet } from "../kv.js";
import { readVaultCredentials } from "../vault-credential-custody.js";
import { vaultStore } from "../vault/store.js";
import { secretBackendCredentialTarget } from "./credential-custody.js";
import { secretBackendDraft } from "./presets.js";
import {
  connectSecretBackend,
  deleteSecretBackendConnection,
  saveSecretBackendConnection,
} from "./runtime.js";
import {
  deferred,
  remoteDraft,
  runtimeFixture,
  runtimePassword,
} from "./runtime.test-support.js";
import {
  readSecretBackendConnection,
  secretBackendRuntimeConfiguration,
} from "./store.js";

let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  await fixture.close();
});
const Reference = z.object({
  v: z.literal(1),
  revision: z.string(),
  entries: z.array(z.object({ field: z.string(), id: z.string() })),
});
function reference(id: string): string {
  const raw = readDeviceRows().find((row) => row.connectionId === id)?.fields
    .secret_backend_credentials;
  if (!raw) throw new Error("Expected vault credential reference");
  return raw;
}
function actualCredentials(id: string) {
  const draft = readSecretBackendConnection(id);
  if (!draft) throw new Error("Expected public configuration");
  return readVaultCredentials(
    reference(id),
    secretBackendCredentialTarget(draft),
    ["token", "clientSecret"],
    vaultStore.getSnapshot().tomb,
  );
}

it("keeps a BWS token in an actual vault credential, never in either public or device-sealed connector payload", async () => {
  const token = "0.fixture-bws-access-token";
  const draft = {
    ...secretBackendDraft("bitwarden"),
    name: "BWS custody fixture",
    mode: "bitwarden-secrets" as const,
    baseUrl: "https://api.bitwarden.com",
    token,
  };
  const saved = await saveSecretBackendConnection(draft);
  const held = actualCredentials(saved.connectionId);
  expect(held.fields.get("token")).toBe(token);
  expect(held.items).toHaveLength(1);
  expect(held.items[0]).toMatchObject({
    name: `Access token · ${draft.name}`,
    kind: "credential",
    method: { type: "token", token },
  });
  expect(readDeviceSecrets()[saved.connectionId]).toBeUndefined();
  expect(JSON.stringify(readDeviceRows())).not.toContain(token);
  expect(kvGet("opensesame.self-hosted-connectors.v1")).not.toContain(token);
  expect(
    [...fixture.files.values()].every((value) => !value.includes(token)),
  ).toBe(true);
  const exported = vaultStore.exportSealed();
  expect(exported).not.toContain(token);
  const item = held.items[0];
  if (!item) throw new Error("Expected token credential");
  await vaultStore.trashItem(item.id);
  await vaultStore.purgeItem(item.id);
  expect(
    secretBackendRuntimeConfiguration(
      saved.connectionId,
      vaultStore.getSnapshot().tomb,
    ),
  ).toBeNull();
  expect(
    await vaultStore.importSealed(exported, runtimePassword, {
      adoptIdentity: false,
    }),
  ).toBe(1);
  expect(actualCredentials(saved.connectionId).fields.get("token")).toBe(token);
  const tomb = vaultStore.getSnapshot().tomb;
  vaultStore.lock();
  expect(
    secretBackendRuntimeConfiguration(saved.connectionId, tomb),
  ).toBeNull();
  await vaultStore.unlock(runtimePassword);
  expect(actualCredentials(saved.connectionId).fields.get("token")).toBe(token);
});

it("replaces token revisions only after metadata commits, and failed metadata writes preserve the original token and reference", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const oldReference = reference(saved.connectionId);
  const oldId = actualCredentials(saved.connectionId).items[0]?.id;
  fixture.beforeAtomicWrite(async () => {
    throw new Error("metadata unavailable");
  });
  await expect(
    saveSecretBackendConnection(
      { ...remoteDraft(), token: "replacement-token-fixture" },
      saved.connectionId,
    ),
  ).rejects.toThrow("metadata unavailable");
  expect(reference(saved.connectionId)).toBe(oldReference);
  expect(actualCredentials(saved.connectionId).fields.get("token")).toBe(
    remoteDraft().token,
  );
  expect(
    vaultStore.getSnapshot().items.filter((item) => item.kind === "credential"),
  ).toHaveLength(1);
  fixture.beforeAtomicWrite();
  await saveSecretBackendConnection(
    {
      ...remoteDraft(),
      token: "replacement-token-fixture",
      baseUrl: "https://replacement.example.com",
    },
    saved.connectionId,
  );
  expect(reference(saved.connectionId)).not.toBe(oldReference);
  expect(actualCredentials(saved.connectionId).fields.get("token")).toBe(
    "replacement-token-fixture",
  );
  expect(vaultStore.getSnapshot().items.some((item) => item.id === oldId)).toBe(
    false,
  );
  await deleteSecretBackendConnection(saved.connectionId);
  expect(
    vaultStore.getSnapshot().items.filter((item) => item.kind === "credential"),
  ).toEqual([]);
});

it.each(["wrong-target", "ordinary-item", "duplicate-field", "invalid-json"])(
  "rejects %s credential references without sending any token",
  async (tamper) => {
    const saved = await saveSecretBackendConnection(remoteDraft());
    const parsed = Reference.parse(JSON.parse(reference(saved.connectionId)));
    const ordinary = createCredential(
      {
        id: crypto.randomUUID(),
        type: "token",
        token: "unrelated-vault-token",
        expiresAt: "",
      },
      "Unrelated token",
    );
    await vaultStore.saveItem(ordinary);
    let raw = reference(saved.connectionId);
    if (tamper === "ordinary-item")
      raw = JSON.stringify({
        ...parsed,
        entries: [{ field: "token", id: ordinary.id }],
      });
    if (tamper === "duplicate-field")
      raw = JSON.stringify({
        ...parsed,
        entries: [...parsed.entries, ...parsed.entries],
      });
    if (tamper === "invalid-json") raw = "not-json";
    await updateDeviceConfigurationDurable(
      saved.connectionId,
      async (record) => {
        record.row.fields.secret_backend_credentials = raw;
        if (tamper === "wrong-target") {
          const draft = readSecretBackendConnection(saved.connectionId);
          if (!draft) throw new Error("Expected public draft");
          record.row.fields.secret_backend_configuration = JSON.stringify({
            ...draft,
            baseUrl: "https://attacker.example.com",
          });
        }
        return { row: record.row, secrets: {} };
      },
    );
    fixture.fetcher.mockClear();
    await expect(
      connectSecretBackend(saved.connectionId),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(fixture.fetcher).not.toHaveBeenCalled();
    await deleteSecretBackendConnection(saved.connectionId);
    expect(
      vaultStore.getSnapshot().items.some((item) => item.id === ordinary.id),
    ).toBe(true);
  },
);

it("editing or trashing the referenced vault token invalidates an admitted connection", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const open = await connectSecretBackend(saved.connectionId);
  const item = actualCredentials(saved.connectionId).items[0];
  if (!item || item.method.type !== "token") throw new Error("Expected token");
  await vaultStore.saveItem({
    ...item,
    method: { ...item.method, token: "user-edited-token" },
  });
  fixture.fetcher.mockClear();
  await expect(open.backend.listItems(open.session)).rejects.toMatchObject({
    code: "stale",
  });
  expect(fixture.fetcher).not.toHaveBeenCalled();
  const reconnect = await connectSecretBackend(saved.connectionId);
  await vaultStore.trashItem(item.id);
  await expect(
    reconnect.backend.listItems(reconnect.session),
  ).rejects.toMatchObject({ code: "stale" });
  const draft = readSecretBackendConnection(saved.connectionId);
  if (!draft) throw new Error("Expected saved public configuration");
  await expect(
    saveSecretBackendConnection(draft, saved.connectionId),
  ).rejects.toMatchObject({ code: "configuration" });
  await saveSecretBackendConnection(
    { ...draft, token: "repaired-token-fixture" },
    saved.connectionId,
  );
  expect(actualCredentials(saved.connectionId).fields.get("token")).toBe(
    "repaired-token-fixture",
  );
  const repaired = await connectSecretBackend(saved.connectionId);
  expect(await repaired.backend.listItems(repaired.session)).toEqual([]);
});

it("refuses publication when a staged vault credential changes, preserving the original config and the user's edited item", async () => {
  const saved = await saveSecretBackendConnection(remoteDraft());
  const original = reference(saved.connectionId);
  const originalId = actualCredentials(saved.connectionId).items[0]?.id;
  const entered = deferred<void>();
  const resume = deferred<void>();
  fixture.beforeAtomicWrite(async () => {
    entered.resolve();
    await resume.promise;
  });
  const pending = saveSecretBackendConnection(
    { ...remoteDraft(), token: "staged-token-fixture" },
    saved.connectionId,
  );
  const failure = expect(pending).rejects.toMatchObject({
    code: "invalid_reference",
  });
  await entered.promise;
  const staged = vaultStore
    .getSnapshot()
    .items.find((item) => item.kind === "credential" && item.id !== originalId);
  if (!staged) throw new Error("Expected staged credential");
  await vaultStore.saveItem({ ...staged, name: "Keep this edited token item" });
  resume.resolve();
  await failure;
  expect(reference(saved.connectionId)).toBe(original);
  expect(actualCredentials(saved.connectionId).fields.get("token")).toBe(
    remoteDraft().token,
  );
  expect(
    vaultStore.getSnapshot().items.find((item) => item.id === staged.id)?.name,
  ).toBe("Keep this edited token item");
});
