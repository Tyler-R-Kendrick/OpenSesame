import { createDecipheriv } from "node:crypto";
import { createItem, readVaultFile } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
} from "./device-connector-records.js";
import { ensureDeviceIdentityKey } from "./device-identity-key.js";
import { kvFileName, kvFlush, kvForgetFiles, kvHydrate } from "./kv.js";
import { readNativeConnector } from "./native-connector-store.js";
import { openNativeGithubBackup } from "./native-github-backup.js";
import {
  gitBlob,
  githubBackupTarget,
  githubBackupToken,
  nativeGithubBackupFixture,
} from "./native-github-backup.test-support.js";
import { configureNativeGithubPersonal } from "./native-github-personal.js";
import { createProject, setActiveProject } from "./projects.js";
import {
  type SecretBackendBackupHandle,
  backUpVaultToSecretBackend,
  restoreVaultFromSecretBackend,
} from "./secret-backends/backup-transfer.js";
import { unwrapExportedVaultKey } from "./vault/offline-backup-file.js";
import { VaultStore, vaultStore } from "./vault/store.js";
import { vfsFlush } from "./vfs.js";

let fixture: Awaited<ReturnType<typeof nativeGithubBackupFixture>>;
const handles: SecretBackendBackupHandle[] = [];
const tasks: Promise<unknown>[] = [];
beforeEach(async () => {
  fixture = await nativeGithubBackupFixture();
});
afterEach(async () => {
  for (const open of handles.splice(0))
    await open.backend.disconnect(open.session);
  await Promise.allSettled(tasks.splice(0));
  vi.restoreAllMocks();
  await setActiveProject("personal");
  await fixture.close();
});
async function open() {
  const handle = await openNativeGithubBackup(
    fixture.saved.connectionId,
    githubBackupTarget,
    {
      vault: vaultStore,
      transport: fixture.transport,
      signal: fixture.action.signal,
    },
  );
  handles.push(handle);
  return handle;
}
async function prepared() {
  const entry = createItem("secret", "GitHub source only");
  entry.value = "github-native-encrypted-vault-canary";
  await vaultStore.saveItem(entry);
  const handle = await open();
  const backup = await backUpVaultToSecretBackend(
    handle,
    "Native GitHub backup",
  );
  const stored = await handle.backend.getItem(backup.id, handle.session);
  return { entry, handle, backup, stored };
}
function createInput(notes: string) {
  return { name: "Encrypted vault", kind: "note" as const, notes, secret: "" };
}
async function destination() {
  const project = await createProject(`Restore ${crypto.randomUUID()}`);
  await setActiveProject(project.id);
  const vault = new VaultStore();
  await vault.createWithPin("68391527");
  const kept = createItem("note", "Existing destination note");
  await vault.saveItem(kept);
  const identity = await ensureDeviceIdentityKey(vault.getSnapshot().tomb);
  return { vault, kept, identity };
}

it("uses actual Contents/ref TLS requests and independently decrypts ciphertext, then restores into a separate PIN vault", async () => {
  await vaultStore.enrollPin("83619472");
  await vaultStore.removePassword();
  const { entry, handle, backup, stored } = await prepared();
  const blob = fixture.state.files.get(backup.id);
  expect(blob).toBeDefined();
  expect(blob?.sha).toBe(gitBlob(blob?.bytes ?? Buffer.alloc(0)));
  expect(blob?.bytes.toString()).not.toContain(entry.value);
  expect(blob?.bytes.toString()).not.toContain(githubBackupToken);
  expect(JSON.stringify(readDeviceRows())).not.toContain(githubBackupToken);
  await kvFlush();
  expect([...fixture.local.files.values()].join()).not.toContain(
    githubBackupToken,
  );
  const file = readVaultFile(stored.notes);
  const raw = await unwrapExportedVaultKey(file.header, "83619472");
  try {
    const encrypted = Buffer.from(file.body.ctB64, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      raw,
      Buffer.from(file.body.ivB64, "base64"),
    );
    decipher.setAAD(Buffer.from(`vault-seal\0${file.tomb}\0body`));
    decipher.setAuthTag(encrypted.subarray(-16));
    const body = Buffer.concat([
      decipher.update(encrypted.subarray(0, -16)),
      decipher.final(),
    ]).toString();
    expect(body).toContain(entry.value);
    const target = await destination();
    try {
      await expect(
        restoreVaultFromSecretBackend(
          handle,
          backup.id,
          "wrong source PIN",
          target.vault,
        ),
      ).rejects.toThrow();
      expect(target.vault.getSnapshot().items).toEqual([
        expect.objectContaining({ id: target.kept.id }),
      ]);
      await expect(
        restoreVaultFromSecretBackend(handle, backup.id, raw, target.vault),
      ).resolves.toBe(1);
      await expect(
        restoreVaultFromSecretBackend(handle, backup.id, raw, target.vault),
      ).resolves.toBe(0);
      await target.vault.flushPendingWrites();
      await vfsFlush();
      target.vault.lock();
      await expect(target.vault.unlockWithPin("83619472")).rejects.toThrow();
      await target.vault.unlockWithPin("68391527");
      expect(target.vault.getSnapshot().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: target.kept.id }),
          expect.objectContaining({ id: entry.id, value: entry.value }),
        ]),
      );
      expect(
        (await ensureDeviceIdentityKey(target.vault.getSnapshot().tomb)).keyId,
      ).toBe(target.identity.keyId);
    } finally {
      target.vault.lock();
      await setActiveProject("personal");
    }
  } finally {
    raw.fill(0);
  }
  const paths = fixture.state.requests.map((row) => row.url);
  expect(
    paths.some((path) => path.includes("/git/ref/heads/backup/encrypted")),
  ).toBe(true);
  expect(
    paths
      .filter((path) => path.includes("/contents/") && path.includes("?ref="))
      .every((path) => /\?ref=[a-f0-9]{40}$/.test(path)),
  ).toBe(true);
  const puts = fixture.state.requests.filter((row) => row.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(JSON.parse(puts[0]?.body ?? "{}")).not.toHaveProperty("sha");
});

it("performs explicit SHA-CAS updates and refuses stale revisions, race conflicts and create collisions", async () => {
  const { handle, backup, stored } = await prepared();
  const update = handle.backend.updateItem;
  if (!update) throw new Error("Missing native CAS update");
  await vaultStore.saveItem(createItem("note", "Later edit"));
  const later = await backUpVaultToSecretBackend(handle, "Later backup");
  const changed = await handle.backend.getItem(later.id, handle.session);
  const input = {
    ...createInput(changed.notes),
    fields: { sha: stored.fields?.sha ?? "" },
  };
  const updated = await update(backup.id, input, handle.session);
  expect(updated.fields?.sha).not.toBe(stored.fields?.sha);
  await expect(update(backup.id, input, handle.session)).rejects.toMatchObject({
    code: "configuration",
  });
  fixture.state.race = true;
  await expect(
    update(
      backup.id,
      { ...input, fields: { sha: updated.fields?.sha ?? "" } },
      handle.session,
    ),
  ).rejects.toMatchObject({ code: "configuration" });
  expect(fixture.state.files.get(backup.id)?.sha).not.toBe(updated.fields?.sha);
  expect((await handle.backend.getItem(backup.id, handle.session)).notes).toBe(
    updated.notes,
  );
  const parts = backup.id.slice("backups/".length, -".json".length).split("-");
  vi.spyOn(crypto, "randomUUID").mockImplementation(
    () => `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3]}-${parts[4]}`,
  );
  await expect(
    backUpVaultToSecretBackend(handle, "Collision"),
  ).rejects.toMatchObject({ code: "configuration" });
  const puts = fixture.state.requests.filter((row) => row.method === "PUT");
  expect(JSON.parse(puts[2]?.body ?? "{}").sha).toBe(stored.fields?.sha);
});

it("requires a real provider commit receipt before reporting a backup write", async () => {
  const handle = await open();
  await vaultStore.saveItem(createItem("note", "Receipt source"));
  fixture.state.corrupt = "write";
  await expect(
    backUpVaultToSecretBackend(handle, "Missing receipt"),
  ).rejects.toMatchObject({ code: "response" });
  expect(fixture.state.files.size).toBe(1);
  expect(
    fixture.state.requests.filter(
      (row) => row.url.includes("/contents/") && row.method === "GET",
    ),
  ).toHaveLength(0);
});

it.each(["sha", "path", "encoding", "size", "ciphertext", "large", "ref"])(
  "rejects actual malformed %s provider data",
  async (corrupt) => {
    const { handle, backup } = await prepared();
    fixture.state.corrupt = corrupt;
    await expect(
      handle.backend.getItem(backup.id, handle.session),
    ).rejects.toThrow();
  },
);
it.each([401, 403, 404, 409, 422, 429, 500])(
  "sanitizes actual HTTP %s and invalidates only refused credentials",
  async (status) => {
    const handle = await open();
    fixture.state.deny = status;
    let message = "";
    try {
      await handle.backend.getItem(
        "opensesame-vault.backup.json",
        handle.session,
      );
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(githubBackupToken);
    expect(message).not.toBe("");
    expect(
      readNativeConnector(fixture.saved.connectionId)?.status === "connected",
    ).toBe(status !== 401);
  },
);
it.each(["provider", "action", "vault", "edit", "disconnect"] as const)(
  "drains actual held I/O when %s authority ends",
  async (withdrawal) => {
    const handle = await open();
    fixture.state.hold = "GET";
    const pending = handle.backend.getItem(
      "opensesame-vault.backup.json",
      handle.session,
    );
    tasks.push(pending);
    const rejected = expect(pending).rejects.toThrow();
    await expect.poll(() => fixture.state.held).toBeDefined();
    if (withdrawal === "provider") fixture.provider.abort();
    if (withdrawal === "action") fixture.action.abort();
    if (withdrawal === "vault") vaultStore.lock();
    if (withdrawal === "disconnect")
      await handle.backend.disconnect(handle.session);
    if (withdrawal === "edit")
      await configureNativeGithubPersonal(
        {
          ...fixture.draft,
          connectionId: fixture.saved.connectionId,
          revision: fixture.saved.revision,
          displayName: "Changed backup token connection",
        },
        fixture.transport,
      );
    await rejected;
    await expect.poll(() => fixture.state.held?.premature).toBe(true);
    const count = fixture.state.requests.length;
    await expect(
      handle.backend.getItem("opensesame-vault.backup.json", handle.session),
    ).rejects.toThrow();
    expect(fixture.state.requests).toHaveLength(count);
  },
);
it("validates target, session, ciphertext, size and expected SHA before protected writes", async () => {
  await expect(
    openNativeGithubBackup(
      fixture.saved.connectionId,
      { ...githubBackupTarget, branch: "../main" },
      { vault: vaultStore, transport: fixture.transport },
    ),
  ).rejects.toMatchObject({ code: "configuration" });
  const handle = await open();
  const count = fixture.state.requests.length;
  await expect(
    handle.backend.getItem("../foreign", handle.session),
  ).rejects.toMatchObject({ code: "configuration" });
  await expect(
    handle.backend.getItem("opensesame-vault.backup.json", {
      ...handle.session,
    }),
  ).rejects.toMatchObject({ code: "stale" });
  const create = handle.backend.createItem;
  const update = handle.backend.updateItem;
  if (!create || !update) throw new Error("Missing native backup methods");
  await expect(
    create(createInput("plaintext"), handle.session),
  ).rejects.toMatchObject({ code: "response" });
  await expect(
    create(createInput("é".repeat(262145)), handle.session),
  ).rejects.toMatchObject({ code: "unsupported" });
  await expect(
    update("opensesame-vault.backup.json", createInput("{}"), handle.session),
  ).rejects.toMatchObject({ code: "configuration" });
  expect(fixture.state.requests).toHaveLength(count);
});

it("verifies and durably preserves an explicit target while ending its prior backup owner", async () => {
  const prior = await open();
  const parameters = {
    backup_owner: "octocat",
    backup_repo: "sealed-vault",
    backup_branch: "backup/encrypted",
  };
  const updated = await configureNativeGithubPersonal(
    {
      ...fixture.draft,
      connectionId: fixture.saved.connectionId,
      revision: fixture.saved.revision,
      parameters,
    },
    fixture.transport,
  );
  expect(updated.configuration.parameters).toEqual(parameters);
  expect(prior.session.signal?.aborted).toBe(true);
  expect(fixture.state.requests.at(-1)?.url).toBe(
    "/repos/octocat/sealed-vault/git/ref/heads/backup/encrypted",
  );
  expect(updated.grants[0]?.permissionState).toBe("provider-managed");
  await kvFlush();
  kvForgetFiles(new Set(DEVICE_CONNECTOR_KEYS.map(kvFileName)));
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  expect(
    readNativeConnector(updated.connectionId)?.configuration.parameters,
  ).toEqual(parameters);
  expect(JSON.stringify(readDeviceRows())).not.toContain(githubBackupToken);
  expect([...fixture.local.files.values()].join()).not.toContain(
    githubBackupToken,
  );
});
type TargetParameters = Record<string, string>;
type InvalidTargets = TargetParameters[];
const invalidTargets: InvalidTargets = [
  { backup_owner: "octocat" },
  {
    backup_owner: "octocat",
    backup_repo: "sealed-vault",
    backup_branch: "../bad",
  },
  { endpoint: "https://foreign.example" },
];
it.each(invalidTargets)(
  "refuses invalid target parameters before HTTP: %o",
  async (parameters) => {
    const count = fixture.state.requests.length;
    await expect(
      configureNativeGithubPersonal(
        { ...fixture.draft, parameters },
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(fixture.state.requests).toHaveLength(count);
  },
);
it("does not save a nonexistent branch or discard the existing configured binding", async () => {
  const previous = readNativeConnector(fixture.saved.connectionId);
  await expect(
    configureNativeGithubPersonal(
      {
        ...fixture.draft,
        connectionId: fixture.saved.connectionId,
        revision: fixture.saved.revision,
        parameters: {
          backup_owner: "octocat",
          backup_repo: "sealed-vault",
          backup_branch: "missing",
        },
      },
      fixture.transport,
    ),
  ).rejects.toThrow();
  expect(readNativeConnector(fixture.saved.connectionId)).toEqual(previous);
});
