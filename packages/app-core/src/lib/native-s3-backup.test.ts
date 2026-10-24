import { createItem, readVaultFile } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { ensureDeviceIdentityKey } from "./device-identity-key.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
} from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { openNativeS3Backup } from "./native-s3-backup.js";
import { configureNativeS3, nativeS3Cleanup } from "./native-s3.js";
import {
  type SecretBackendBackupHandle,
  backUpVaultToSecretBackend,
  restoreVaultFromSecretBackend,
} from "./secret-backends/backup-transfer.js";
import {
  deferred,
  runtimePassword,
} from "./secret-backends/runtime.test-support.js";
import { nativeS3BackupFixture } from "./test/native-s3-backup-fixtures.js";
import { unwrapExportedVaultKey } from "./vault/offline-backup-file.js";
import { bodyPortOf } from "./vault/store-device-key.js";
import { vaultStore } from "./vault/store.js";

let fixture: Awaited<ReturnType<typeof nativeS3BackupFixture>>;
const handles: SecretBackendBackupHandle[] = [];
const resumes: (() => void)[] = [];
const tasks: Promise<unknown>[] = [];
beforeEach(async () => {
  fixture = await nativeS3BackupFixture("vault %/nested/");
});
afterEach(async () => {
  for (const resume of resumes.splice(0)) resume();
  for (const open of handles.splice(0))
    await open.backend.disconnect(open.session);
  await Promise.allSettled(tasks.splice(0));
  vi.restoreAllMocks();
  await fixture.close();
});
async function open() {
  const handle = await openNativeS3Backup(fixture.saved.connectionId, {
    transport: fixture.transport,
    vault: vaultStore,
    signal: fixture.action.signal,
    assertCurrent: () => fixture.action.signal.throwIfAborted(),
  });
  handles.push(handle);
  return handle;
}
async function source() {
  const identity = await ensureDeviceIdentityKey(vaultStore.getSnapshot().tomb);
  const entry = createItem("secret", "Backup source only");
  entry.value = "native-s3-encrypted-canary";
  await vaultStore.saveItem(entry);
  return { entry, identity: identity.keyId };
}
async function prepare() {
  const prepared = await source();
  const handle = await open();
  const backup = await backUpVaultToSecretBackend(
    handle,
    "Real native S3 backup",
  );
  const stored = await handle.backend.getItem(backup.id, handle.session);
  const raw = await unwrapExportedVaultKey(
    readVaultFile(stored.notes).header,
    runtimePassword,
  );
  await vaultStore.trashItem(prepared.entry.id);
  await vaultStore.purgeItem(prepared.entry.id);
  const kept = createItem("note", "Created after backup");
  await vaultStore.saveItem(kept);
  return { ...prepared, handle, backup, stored, raw, kept };
}

it("uploads real ciphertext, verifies GET readback, and restores through the actual merge importer", async () => {
  const prepared = await prepare();
  try {
    expect(fixture.requests.map((row) => row.method)).toEqual([
      "GET",
      "PUT",
      "GET",
      "GET",
    ]);
    const put = fixture.requests.find((row) => row.method === "PUT");
    expect(put?.conditional).toBe("*");
    expect(put?.path).toBe(`/test-bucket/vault %/nested/${prepared.backup.id}`);
    const bytes = fixture.objects.get(put?.path ?? "");
    expect(bytes?.toString("utf8")).toBe(prepared.stored.notes);
    expect(bytes?.toString("utf8")).not.toContain(prepared.entry.value);
    expect(JSON.stringify(readDeviceRows())).not.toContain(
      "fixture-private-signing-secret",
    );
    expect(prepared.handle.session.signal).toBe(prepared.handle.backend.signal);
    await expect(
      restoreVaultFromSecretBackend(
        prepared.handle,
        prepared.backup.id,
        prepared.raw,
      ),
    ).resolves.toBe(1);
    expect(vaultStore.getSnapshot().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: prepared.entry.id,
          value: prepared.entry.value,
        }),
        expect.objectContaining({ id: prepared.kept.id }),
      ]),
    );
    expect(bodyPortOf(vaultStore).body().deviceIdentityKey?.keyId).toBe(
      prepared.identity,
    );
    expect(prepared.handle.session.signal?.aborted).toBe(false);
  } finally {
    prepared.raw.fill(0);
  }
});

it("refuses absent capture and an unrelated session without network I/O", async () => {
  const before = fixture.requests.length;
  await expect(
    openNativeS3Backup(fixture.saved.connectionId, {
      vault: vaultStore,
      transport: {
        fetch: fixture.transport.fetch,
        assertCurrent: fixture.transport.assertCurrent,
      },
    }),
  ).rejects.toMatchObject({ code: "configuration" });
  const handle = await open();
  await expect(
    handle.backend.getItem("backups/foreign.json", { ...handle.session }),
  ).rejects.toMatchObject({ code: "stale" });
  expect(fixture.requests).toHaveLength(before);
});

it("enforces the UTF-8 byte cap and accepts only actual encrypted vault payloads before dispatch", async () => {
  const handle = await open();
  const before = fixture.requests.length;
  const create = handle.backend.createItem;
  if (!create) throw new Error("Missing real native backup writer");
  await expect(
    create(
      {
        name: "Too large",
        kind: "note",
        notes: "é".repeat(2 * 1024 * 1024 + 1),
        secret: "",
      },
      handle.session,
    ),
  ).rejects.toMatchObject({ code: "unsupported" });
  await expect(
    create(
      {
        name: "Plaintext",
        kind: "note",
        notes: "never upload this plaintext",
        secret: "",
      },
      handle.session,
    ),
  ).rejects.toMatchObject({ code: "response" });
  expect(fixture.requests).toHaveLength(before);
});

it("uses create-only writes so a collision cannot clobber the previous encrypted backup", async () => {
  await source();
  const handle = await open();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    "12345678-1234-4234-8234-123456789abc",
  );
  const first = await backUpVaultToSecretBackend(handle, "First");
  const original = await handle.backend.getItem(first.id, handle.session);
  await expect(
    backUpVaultToSecretBackend(handle, "Collision"),
  ).rejects.toMatchObject({ code: "configuration" });
  expect(await handle.backend.getItem(first.id, handle.session)).toEqual(
    original,
  );
  expect(
    fixture.requests
      .filter((row) => row.method === "PUT")
      .map((row) => row.conditional),
  ).toEqual(["*", "*"]);
});

it.each([401, 403])(
  "invalidates proof on actual HTTP %s while retaining authority for real cleanup",
  async (status) => {
    const handle = await open();
    fixture.deny(status);
    await expect(
      handle.backend.getItem("backups/missing.json", handle.session),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(readNativeConnector(fixture.saved.connectionId)?.status).not.toBe(
      "connected",
    );
    const retained = loadNativeConnectorRecord(fixture.saved.connectionId);
    expect(retained?.privateState.credentials.secret_access_key).toBe(
      "fixture-private-signing-secret",
    );
    expect(retained?.privateState.grants.app).toBeDefined();
    expect(handle.session.signal?.aborted).toBe(true);
    const release = registerNativeProviderCleanup("s3", nativeS3Cleanup);
    try {
      await removeNativeConnectorWithCleanup(fixture.saved.connectionId);
    } finally {
      release();
    }
    expect(loadNativeConnectorRecord(fixture.saved.connectionId)).toBeNull();
  },
);

it.each(["provider", "vault", "action", "edit", "disconnect"] as const)(
  "closes a held upload and prevents readback when %s authority ends",
  async (withdraw) => {
    await source();
    const handle = await open();
    fixture.hold("PUT");
    const pending = backUpVaultToSecretBackend(handle, "Held encrypted upload");
    tasks.push(pending);
    const rejected = expect(pending).rejects.toThrow();
    await expect.poll(fixture.held).toBeDefined();
    if (withdraw === "provider") fixture.provider.abort();
    if (withdraw === "vault") vaultStore.lock();
    if (withdraw === "action") fixture.action.abort();
    if (withdraw === "disconnect")
      await handle.backend.disconnect(handle.session);
    if (withdraw === "edit")
      await configureNativeS3(
        {
          ...fixture.draft,
          displayName: "Reconfigured native bucket",
          connectionId: fixture.saved.connectionId,
          revision: fixture.saved.revision,
        },
        fixture.transport,
      );
    await rejected;
    await expect.poll(() => fixture.held()?.premature).toBe(true);
    expect(
      fixture.requests.filter(
        (row) => row.method === "GET" && !row.path.endsWith("/"),
      ),
    ).toHaveLength(0);
    expect(handle.session.signal?.aborted).toBe(true);
  },
);

it("does not import or publish a late held read after caller withdrawal", async () => {
  const prepared = await prepare();
  try {
    fixture.hold("GET");
    const pending = restoreVaultFromSecretBackend(
      prepared.handle,
      prepared.backup.id,
      prepared.raw,
    );
    tasks.push(pending);
    const rejected = expect(pending).rejects.toThrow();
    await expect.poll(fixture.held).toBeDefined();
    fixture.action.abort();
    await rejected;
    await expect.poll(() => fixture.held()?.premature).toBe(true);
    expect(vaultStore.getSnapshot().items).toEqual([
      expect.objectContaining({ id: prepared.kept.id }),
    ]);
    expect(bodyPortOf(vaultStore).body().deviceIdentityKey?.keyId).toBe(
      prepared.identity,
    );
  } finally {
    prepared.raw.fill(0);
  }
});

it("keeps the captured signal in the final real decrypt/import guard", async () => {
  const prepared = await prepare();
  const entered = deferred<void>();
  const resume = deferred<void>();
  resumes.push(() => resume.resolve());
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
    const plaintext = await decrypt(...args);
    entered.resolve();
    await resume.promise;
    return plaintext;
  });
  const pending = restoreVaultFromSecretBackend(
    prepared.handle,
    prepared.backup.id,
    prepared.raw,
  );
  tasks.push(pending);
  const rejected = expect(pending).rejects.toThrow();
  try {
    await entered.promise;
    fixture.action.abort();
    resume.resolve();
    await rejected;
    expect(vaultStore.getSnapshot().items).toEqual([
      expect.objectContaining({ id: prepared.kept.id }),
    ]);
    expect(bodyPortOf(vaultStore).body().deviceIdentityKey?.keyId).toBe(
      prepared.identity,
    );
  } finally {
    prepared.raw.fill(0);
  }
});

it("refuses truncated ciphertext and a wrong raw unlock without changing destination items", async () => {
  const prepared = await prepare();
  try {
    const wrong = prepared.raw.slice();
    wrong[0] = (wrong[0] ?? 0) ^ 255;
    await expect(
      restoreVaultFromSecretBackend(prepared.handle, prepared.backup.id, wrong),
    ).rejects.toThrow();
    wrong.fill(0);
    fixture.corrupt();
    await expect(
      restoreVaultFromSecretBackend(
        prepared.handle,
        prepared.backup.id,
        prepared.raw,
      ),
    ).rejects.toThrow();
    expect(vaultStore.getSnapshot().items).toEqual([
      expect.objectContaining({ id: prepared.kept.id }),
    ]);
  } finally {
    prepared.raw.fill(0);
  }
});

it("refuses incomplete readback and bounds an actual oversized object before parsing", async () => {
  await source();
  const handle = await open();
  fixture.corrupt();
  await expect(
    backUpVaultToSecretBackend(handle, "Damaged readback"),
  ).rejects.toMatchObject({ code: "response" });
  fixture.objects.set(
    "/test-bucket/vault %/nested/backups/large.json",
    Buffer.alloc(10 * 1024 * 1024),
  );
  await expect(
    handle.backend.getItem("backups/large.json", handle.session),
  ).rejects.toMatchObject({ code: "network" });
});

it("does not adopt a relocked-and-unlocked vault while capture validation is awaiting a real digest", async () => {
  await vaultStore.flushPendingWrites();
  const entered = deferred<void>();
  const resume = deferred<void>();
  resumes.push(() => resume.resolve());
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
    const value = await digest(...args);
    entered.resolve();
    await resume.promise;
    return value;
  });
  const pending = openNativeS3Backup(fixture.saved.connectionId, {
    transport: fixture.transport,
    vault: vaultStore,
  });
  tasks.push(pending);
  const rejected = expect(pending).rejects.toThrow();
  await entered.promise;
  vaultStore.lock();
  await vaultStore.unlock(runtimePassword);
  resume.resolve();
  await rejected;
  expect(fixture.requests).toHaveLength(1);
});
