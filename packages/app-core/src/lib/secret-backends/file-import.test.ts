import { readFileSync } from "node:fs";
import { accountFilePassword } from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { kvFlush, kvForgetAll } from "../kv.js";
import { VaultStore } from "../vault/store.js";
import { vfsFlush } from "../vfs.js";
import { createFileImportBackend } from "./file-import.js";
import {
  bitwardenExport,
  exportZip,
  onePasswordExport,
  protonExport,
} from "./file-import.test-support.js";
import { secretBackendDraft } from "./presets.js";
import { asBufferSource } from "@opensesame/os-domain";

let store: VaultStore;
beforeEach(async () => {
  await vfsFlush();
  await kvFlush();
  kvForgetAll();
  store = new VaultStore();
  await store.create("controlled genuine backend fixture password");
});
afterEach(async () => {
  await store.flushPendingWrites();
  store.lock();
  await vfsFlush();
  await kvFlush();
  vi.restoreAllMocks();
});
function config(providerId: string, fileFormat: string, file: File) {
  return {
    ...secretBackendDraft(providerId),
    mode: "file-import" as const,
    fileFormat,
    file,
  };
}
it("keeps a Bitwarden snapshot read-only and copies through the real merge/sealed-vault pipeline only when explicitly requested", async () => {
  const backend = createFileImportBackend(store);
  const session = await backend.authenticate(
    config(
      "bitwarden",
      "bitwarden-json",
      new File([bitwardenExport], "bitwarden.json"),
    ),
  );
  expect(backend.capabilities).toMatchObject({
    list: true,
    get: true,
    import: true,
    create: false,
    update: false,
    delete: false,
  });
  expect(backend.createItem).toBeUndefined();
  expect(backend.deleteItem).toBeUndefined();
  expect(store.getSnapshot().items).toEqual([]);
  const [summary] = await backend.listItems(session);
  expect(summary?.name).toBe("Imported Login");
  expect(await backend.getItem(summary?.id ?? "", session)).toMatchObject({
    secret: "import-password-fixture",
    notes: "import-note-fixture",
    username: "reader",
  });
  expect(await backend.importToLocal?.(session)).toMatchObject({
    imported: 1,
    skipped: 0,
  });
  const account = store
    .getSnapshot()
    .items.find((item) => item.kind === "account");
  if (account?.kind !== "account") throw new Error("Expected imported account");
  expect(accountFilePassword(account)).toBe("import-password-fixture");
  expect(
    account.methods.some(
      (method) =>
        method.type === "authenticator" && method.secret === "JBSWY3DPEHPK3PXP",
    ),
  ).toBe(true);
  expect(store.getSnapshot().folders.map((folder) => folder.name)).toContain(
    "Imported folder",
  );
  expect(await backend.importToLocal?.(session)).toMatchObject({
    imported: 0,
    skipped: 1,
  });
  await backend.disconnect(session);
  await expect(
    backend.getItem("Imported Login", session),
  ).rejects.toMatchObject({ code: "authentication" });
});
it("uses the real 1PUX ZIP and Proton Pass JSON/ZIP parsers", async () => {
  const backend = createFileImportBackend(store);
  const cases = [
    config(
      "1password",
      "1password-1pux",
      new File([asBufferSource(exportZip([["export.data", onePasswordExport]]))], "vault.1pux"),
    ),
    config(
      "proton-pass",
      "protonpass-json",
      new File([protonExport], "proton.json"),
    ),
    config(
      "proton-pass",
      "protonpass-json",
      new File(
        [asBufferSource(exportZip([["ProtonPass/export.json", protonExport]]))],
        "proton.zip",
      ),
    ),
  ];
  for (const input of cases) {
    const session = await backend.authenticate(input);
    const entries = await backend.listItems(session);
    expect(entries).toHaveLength(1);
    expect(
      (await backend.getItem(entries[0]?.id ?? "", session)).secret,
    ).toMatch(/^(1p|proton)-fixture$/);
    await backend.disconnect(session);
  }
  expect(store.getSnapshot().items).toEqual([]);
});
it("decrypts an actual KDBX file with a transient password and refuses missing or wrong passwords", async () => {
  const bytes = new Uint8Array(
    readFileSync(
      new URL(
        "../../../../../tests/fixtures/kdbx/roundtrip.kdbx",
        import.meta.url,
      ),
    ),
  );
  const backend = createFileImportBackend(store);
  const input = config(
    "byo-secret-backend",
    "keepass-kdbx",
    new File([bytes], "chosen.kdbx"),
  );
  await expect(backend.authenticate(input)).rejects.toMatchObject({
    code: "authentication",
  });
  await expect(
    backend.authenticate({ ...input, filePassword: "wrong-password" }),
  ).rejects.toThrow();
  const session = await backend.authenticate({
    ...input,
    filePassword: "correct horse battery staple",
  });
  const listed = await backend.listItems(session);
  expect(listed.length).toBeGreaterThan(2);
  const values = await Promise.all(
    listed.map((item) => backend.getItem(item.id, session)),
  );
  expect(values.some((item) => item.secret === "fixture-password-one")).toBe(
    true,
  );
  expect(store.getSnapshot().items).toEqual([]);
  await backend.disconnect(session);
});
it("validates selected provider/format, rejects empty/read-failed/oversized files, and refuses ambiguous or encrypted Proton archives", async () => {
  const backend = createFileImportBackend(store);
  await expect(
    backend.authenticate(
      config(
        "bitwarden",
        "protonpass-json",
        new File([protonExport], "other.json"),
      ),
    ),
  ).rejects.toMatchObject({ code: "configuration" });
  await expect(
    backend.authenticate(
      config(
        "bitwarden",
        "bitwarden-json",
        new File([protonExport], "wrong.json"),
      ),
    ),
  ).rejects.toMatchObject({ code: "response" });
  await expect(
    backend.authenticate(
      config("bitwarden", "bitwarden-json", new File([], "empty.json")),
    ),
  ).rejects.toThrow("empty");
  const broken = new File(["x"], "unreadable.json");
  vi.spyOn(broken, "text").mockRejectedValue(new Error("File access denied"));
  await expect(
    backend.authenticate(config("bitwarden", "bitwarden-json", broken)),
  ).rejects.toThrow("File access denied");
  const oversized = new File(["x"], "huge.json");
  Object.defineProperty(oversized, "size", { value: 64 * 1024 * 1024 + 1 });
  await expect(
    backend.authenticate(config("bitwarden", "bitwarden-json", oversized)),
  ).rejects.toThrow("64 MB");
  const ambiguous = new File(
    [
      asBufferSource(exportZip([
        ["one.json", protonExport],
        ["two.json", protonExport],
      ])),
    ],
    "proton.zip",
  );
  await expect(
    backend.authenticate(config("proton-pass", "protonpass-json", ambiguous)),
  ).rejects.toMatchObject({ code: "ambiguous" });
  const disguised = new File(
    [
      asBufferSource(exportZip([
        ["export.data", protonExport],
        ["one.json", protonExport],
        ["two.json", protonExport],
      ])),
    ],
    "proton.zip",
  );
  await expect(
    backend.authenticate(config("proton-pass", "protonpass-json", disguised)),
  ).rejects.toMatchObject({ code: "ambiguous" });
  const duplicate1pux = new File(
    [
      asBufferSource(exportZip([
        ["one/export.data", onePasswordExport],
        ["two/export.data", onePasswordExport],
      ])),
    ],
    "ambiguous.1pux",
  );
  await expect(
    backend.authenticate(config("1password", "1password-1pux", duplicate1pux)),
  ).rejects.toMatchObject({ code: "ambiguous" });
  const encrypted = new File(
    [asBufferSource(exportZip([["data.pgp", "encrypted"]]))],
    "proton.zip",
  );
  await expect(
    backend.authenticate(config("proton-pass", "protonpass-json", encrypted)),
  ).rejects.toThrow("Decrypt encrypted exports locally");
});
it("duplicate names require IDs, a copied handle fails, and vault lock revokes the imported snapshot", async () => {
  const raw = JSON.parse(bitwardenExport);
  raw.items.push({ ...raw.items[0], notes: "second" });
  const backend = createFileImportBackend(store);
  const session = await backend.authenticate(
    config(
      "bitwarden",
      "bitwarden-json",
      new File([JSON.stringify(raw)], "duplicates.json"),
    ),
  );
  expect(await backend.listItems(session)).toHaveLength(2);
  await expect(
    backend.getNotes("Imported Login", session),
  ).rejects.toMatchObject({ code: "ambiguous" });
  await expect(backend.listItems({ ...session })).rejects.toMatchObject({
    code: "authentication",
  });
  store.lock();
  await expect(backend.listItems(session)).rejects.toMatchObject({
    code: "stale",
  });
  await backend.disconnect(session);
});
it("a late file read cannot create a session after its vault is locked", async () => {
  const file = new File([bitwardenExport], "slow.json");
  let entered: () => void = () => {};
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let complete: (text: string) => void = () => {};
  vi.spyOn(file, "text").mockImplementation(() => {
    entered();
    return new Promise<string>((resolve) => {
      complete = resolve;
    });
  });
  const backend = createFileImportBackend(store);
  const authentication = backend.authenticate(
    config("bitwarden", "bitwarden-json", file),
  );
  await reading;
  store.lock();
  complete(bitwardenExport);
  await expect(authentication).rejects.toMatchObject({ code: "stale" });
});
it("accepts selected plaintext environment exports as snapshots without pretending to decrypt a pass GPG store", async () => {
  const backend = createFileImportBackend(store);
  const input = config(
    "byo-secret-backend",
    "env-file",
    new File(["API_KEY=env-fixture\n"], "decrypted.env"),
  );
  const session = await backend.authenticate(input);
  expect((await backend.getItem("API_KEY", session)).secret).toBe(
    "env-fixture",
  );
  await expect(
    backend.authenticate({
      ...input,
      file: new File(["-----BEGIN PGP MESSAGE-----\nopaque"], "secret.gpg"),
    }),
  ).rejects.toMatchObject({ code: "response" });
});
it("overlapping explicit copies cannot duplicate the same imported snapshot", async () => {
  const backend = createFileImportBackend(store);
  const session = await backend.authenticate(
    config(
      "bitwarden",
      "bitwarden-json",
      new File([bitwardenExport], "vault.json"),
    ),
  );
  const apply = store.applyImport.bind(store);
  let finish: () => void = () => {};
  const paused = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(store, "applyImport").mockImplementationOnce(async (plan) => {
    await paused;
    return apply(plan);
  });
  const first = backend.importToLocal?.(session);
  await expect(backend.importToLocal?.(session)).rejects.toMatchObject({
    code: "stale",
  });
  finish();
  expect(await first).toMatchObject({ imported: 1 });
  expect(await backend.importToLocal?.(session)).toMatchObject({
    imported: 0,
    skipped: 1,
  });
});
