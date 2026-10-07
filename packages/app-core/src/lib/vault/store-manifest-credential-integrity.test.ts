import {
  createCredential,
  createItem,
  manualPassword,
  openWithPepper,
  pepperBinding,
  sealWithPepper,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createRetiredCredentialFixture } from "../retired-credentials/test-support.js";
import { buildCxfExport } from "./export/cxf.js";
import { planManifestMerge, vaultItemToEntry } from "./store-sync.js";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => fixture.restore());
it("imports a standalone credential with a fresh local identity and cannot replace a real note", async () => {
  const note = createItem("note", "Preserved private note");
  note.notes = "REAL_NOTE_SENTINEL";
  await fixture.store.saveItem(note);
  const malicious = createCredential(
    manualPassword(note.id, "IMPORTED_PASSWORD_SENTINEL", note.createdAt),
    "Imported password",
  );
  const state = fixture.store.getSnapshot();
  const plan = planManifestMerge(
    [vaultItemToEntry(malicious, [])],
    state.items,
    state.folders,
  );
  await fixture.store.applyManifestMerge(plan);
  const imported = fixture.store
    .getSnapshot()
    .items.find(
      (item) => item.kind === "credential" && item.name === "Imported password",
    );
  if (!imported || imported.kind !== "credential")
    throw new Error("Imported credential missing");
  await fixture.store.saveItem({
    ...imported,
    notes: "Changed imported credential",
  });
  const after = fixture.store.getSnapshot();
  expect(after.items.find((item) => item.id === note.id)).toMatchObject({
    kind: "note",
    notes: "REAL_NOTE_SENTINEL",
  });
  expect(imported.id).not.toBe(note.id);
  expect(imported.method.id).toBe(imported.id);
  expect(imported.accountId).toBeNull();
});
it("same-path credential updates preserve only the existing local item/method identity", async () => {
  const credential = createCredential(
    manualPassword(crypto.randomUUID(), "BEFORE", new Date().toISOString()),
    "Standalone",
  );
  await fixture.store.saveItem(credential);
  const foreign = createCredential(
    manualPassword(crypto.randomUUID(), "AFTER", credential.createdAt),
    "Standalone",
  );
  const state = fixture.store.getSnapshot();
  const plan = planManifestMerge(
    [vaultItemToEntry(foreign, [])],
    state.items,
    state.folders,
  );
  await fixture.store.applyManifestMerge(plan);
  const after = fixture.store
    .getSnapshot()
    .items.find((item) => item.id === credential.id);
  expect(after).toMatchObject({
    kind: "credential",
    id: credential.id,
    accountId: null,
    method: { id: credential.id, secret: "AFTER" },
  });
});

it("exports a live restored credential whose original account remains trashed", async () => {
  const account = createItem("account", "Trashed account");
  const method = manualPassword(
    `${account.id}:password`,
    "RESTORED_EXPORT_SENTINEL",
    account.createdAt,
  );
  account.methods = [method];
  await fixture.store.saveItem(account);
  await fixture.store.trashItem(account.id);
  await fixture.store.restoreItem(method.id);
  const state = fixture.store.getSnapshot();
  const exported = buildCxfExport(
    { v: 1, items: [...(state.rawItems ?? [])], folders: state.folders },
    { humanConfirmed: true },
  );
  expect(exported.document.accounts[0]?.items.map((item) => item.id)).toEqual([
    method.id,
  ]);
  expect(JSON.stringify(exported.document)).toContain(
    "RESTORED_EXPORT_SENTINEL",
  );
  expect(exported.skipped).toEqual([]);
  expect(exported.withheld).toBe(0);
});

it("refuses rehoming a genuine legacy seal while preserving an exact same-local-id round trip", async () => {
  const id = crypto.randomUUID();
  const method = manualPassword(id, "", new Date().toISOString());
  method.sealed = await sealWithPepper(
    "LEGACY_SEALED_SENTINEL",
    "fixture historical pepper",
    pepperBinding("original-account", id),
  );
  const credential = createCredential(method, "Legacy standalone");
  const entry = vaultItemToEntry(credential, []);
  const empty = fixture.store.getSnapshot();
  expect(() => planManifestMerge([entry], empty.items, empty.folders)).toThrow(
    "Convert this sealed password",
  );
  await fixture.store.saveItem(credential);
  const current = fixture.store.getSnapshot();
  const stored = current.items.find((item) => item.id === id);
  if (!stored || stored.kind !== "credential")
    throw new Error("Current legacy credential missing");
  const unchanged = planManifestMerge(
    [vaultItemToEntry(stored, [])],
    current.items,
    current.folders,
  );
  expect(unchanged).toMatchObject({ adds: [], updates: [], unchanged: 1 });
  await fixture.store.applyManifestMerge(unchanged);
  await expect(
    openWithPepper(
      method.sealed,
      "fixture historical pepper",
      pepperBinding("original-account", id),
    ),
  ).resolves.toBe("LEGACY_SEALED_SENTINEL");
  const altered = createCredential(
    { ...method, id: crypto.randomUUID() },
    credential.name,
  );
  expect(() =>
    planManifestMerge(
      [vaultItemToEntry(altered, [])],
      current.items,
      current.folders,
    ),
  ).toThrow("Convert this sealed password");
  expect(
    fixture.store.getSnapshot().rawItems?.find((item) => item.id === id),
  ).toMatchObject({
    kind: "credential",
    method: { id, sealed: method.sealed },
  });
});

it("exports the active account's bound credential from the actual raw sealed-body view", async () => {
  const account = createItem("account", "Active account");
  const method = manualPassword(
    `${account.id}:password`,
    "ACTIVE_BOUND_EXPORT_SENTINEL",
    account.createdAt,
  );
  account.methods = [method];
  await fixture.store.saveItem(account);
  const state = fixture.store.getSnapshot();
  const rawAccount = state.rawItems?.find((item) => item.id === account.id);
  expect(rawAccount?.kind === "account" && rawAccount.methods).toEqual([]);
  const exported = buildCxfExport(
    { v: 1, items: [...(state.rawItems ?? [])], folders: state.folders },
    { humanConfirmed: true },
  );
  expect(exported.document.accounts[0]?.items.map((item) => item.id)).toEqual([
    account.id,
  ]);
  expect(JSON.stringify(exported.document)).toContain(
    "ACTIVE_BOUND_EXPORT_SENTINEL",
  );
  expect(exported.skipped).toEqual([]);
  expect(exported.withheld).toBe(0);
});
