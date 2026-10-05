import { createItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { completeItemDeparture, packItemDeparture } from "./items-depart.js";
import type { ItemsPackage } from "./items-depart.js";
import { completeItemsReturn, openItemsReturn } from "./items-return.js";
import { fakeItemsVault, folder, login } from "./travel-items.test-support.js";

const ACK = { bundleSaved: true, codeRecorded: true };

function seeded() {
  const bank = login("Bank", { folderId: "f-money", notes: "private" });
  const mail = login("Mail", { folderId: "f-money" });
  const wiki = login("Wiki", { folderId: "f-misc" });
  const vault = fakeItemsVault(
    [bank, mail, wiki],
    [
      folder("f-money", "Money"),
      folder("f-misc", "Misc"),
      folder("f-empty", "Empty already"),
    ],
  );
  return { vault, bank, mail, wiki };
}

async function packed(
  vault: ReturnType<typeof fakeItemsVault>,
  ids: string[],
): Promise<ItemsPackage> {
  const out = await packItemDeparture(vault.deps, { ids });
  if (!out.ok) throw new Error(`pack refused: ${out.code}`);
  return out.pkg;
}

describe("packItemDeparture", () => {
  it("writes nothing and shows the bundle no title, count or date", async () => {
    const { vault, bank } = seeded();
    const before = JSON.stringify(vault.body);
    const pkg = await packed(vault, [bank.id]);
    expect(JSON.stringify(vault.body)).toBe(before);
    expect(vault.purged.activity).toEqual([]);
    const outside = JSON.parse(pkg.bundleJson);
    expect(Object.keys(outside).sort()).toEqual([
      "bundleId",
      "format",
      "sealed",
      "v",
    ]);
    expect(outside.format).toBe("opensesame.travel-items");
    expect(pkg.bundleJson).not.toContain("Bank");
    expect(pkg.bundleJson).not.toContain("2026");
    expect(pkg.returnCode).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  });

  it.each([
    ["owner_not_present", { owner: false }],
    ["duress_active", { duress: true }],
    ["storage_not_durable", { durable: false }],
  ] as const)("refuses with %s", async (code, trip) => {
    const { vault, bank } = seeded();
    Object.assign(vault, trip);
    const out = await packItemDeparture(vault.deps, { ids: [bank.id] });
    expect(out).toMatchObject({ ok: false, code });
  });

  it("refuses an empty choice, an unknown id, a drop and a file", async () => {
    const { vault, bank } = seeded();
    const drop = createItem("drop", "Claim");
    const file = login("Scan", {});
    Object.assign(file, {
      kind: "typed",
      typeId: "file",
      values: {
        bytes: JSON.stringify({
          v: 1,
          name: "w2.pdf",
          mediaType: "application/pdf",
          size: 3,
          key: "k",
          parts: [{ key: "p", nonce: "n" }],
        }),
      },
    });
    vault.body.items.push(drop, file);
    expect(await packItemDeparture(vault.deps, { ids: [] })).toMatchObject({
      code: "nothing_chosen",
    });
    expect(
      await packItemDeparture(vault.deps, { ids: ["nope"] }),
    ).toMatchObject({ code: "unknown_item", ids: ["nope"] });
    expect(
      await packItemDeparture(vault.deps, { ids: [bank.id, drop.id, file.id] }),
    ).toMatchObject({ code: "item_not_hideable", ids: [drop.id, file.id] });
  });

  it("refuses a shared item and every copy it cannot reach", async () => {
    const { vault, bank } = seeded();
    vault.shared.add(bank.id);
    expect(
      await packItemDeparture(vault.deps, { ids: [bank.id] }),
    ).toMatchObject({ code: "item_shared", ids: [bank.id] });
    vault.shared.clear();
    vault.copies.push("backup_target", "paired_drive");
    expect(
      await packItemDeparture(vault.deps, { ids: [bank.id] }),
    ).toMatchObject({
      code: "copies_in_play",
      copies: ["backup_target", "paired_drive"],
    });
  });
});

describe("completeItemDeparture", () => {
  it("removes the items and the folder they alone filled, nothing else", async () => {
    const { vault, bank, mail, wiki } = seeded();
    const pkg = await packed(vault, [bank.id, mail.id]);
    const out = await completeItemDeparture(vault.deps, pkg, ACK);
    expect(out).toMatchObject({
      ok: true,
      receipt: { completion: "applied_local", foldersRemoved: 1 },
    });
    expect(vault.body.items.map((i) => i.id)).toEqual([wiki.id]);
    // Money emptied and left; Misc still holds Wiki; an empty folder that was
    // empty before is not the trip's business.
    expect(vault.body.folders.map((f) => f.id).sort()).toEqual([
      "f-empty",
      "f-misc",
    ]);
    expect(vault.body.tombstones).toBeUndefined();
  });

  it("purges before and after the removal", async () => {
    const { vault, bank } = seeded();
    const pkg = await packed(vault, [bank.id]);
    await completeItemDeparture(vault.deps, pkg, ACK);
    expect(vault.purged.activity).toEqual([[bank.id], [bank.id]]);
    expect(vault.purged.passwords).toEqual([[bank.id], [bank.id]]);
    expect(vault.purged.cache).toEqual(["personal", "personal"]);
  });

  it("needs both halves acknowledged", async () => {
    const { vault, bank } = seeded();
    const pkg = await packed(vault, [bank.id]);
    for (const ack of [
      { bundleSaved: false, codeRecorded: true },
      { bundleSaved: true, codeRecorded: false },
    ]) {
      expect(await completeItemDeparture(vault.deps, pkg, ack)).toMatchObject({
        ok: false,
        code: "not_acknowledged",
      });
    }
    expect(vault.body.items).toHaveLength(3);
  });

  it("checks the gates again, since they can change while the code is on screen", async () => {
    const { vault, bank } = seeded();
    const pkg = await packed(vault, [bank.id]);
    vault.duress = true;
    expect(await completeItemDeparture(vault.deps, pkg, ACK)).toMatchObject({
      ok: false,
      code: "duress_active",
    });
    vault.duress = false;
    vault.copies.push("backup_target");
    expect(await completeItemDeparture(vault.deps, pkg, ACK)).toMatchObject({
      ok: false,
      code: "copies_in_play",
    });
    vault.copies.length = 0;
    vault.shared.add(bank.id);
    expect(await completeItemDeparture(vault.deps, pkg, ACK)).toMatchObject({
      ok: false,
      code: "item_shared",
    });
    expect(vault.body.items).toHaveLength(3);
  });

  it("never removes an item that is not what the bundle holds", async () => {
    const { vault, bank, mail } = seeded();
    const pkg = await packed(vault, [bank.id, mail.id]);
    // Another tab edited one after packing; the mutation sees the disk's copy.
    vault.beforeWithdraw = () => {
      const edited = vault.body.items.find((i) => i.id === mail.id);
      if (edited) edited.notes = "changed elsewhere";
    };
    const out = await completeItemDeparture(vault.deps, pkg, ACK);
    expect(out).toMatchObject({
      ok: false,
      code: "changed_since_packed",
      ids: [mail.id],
    });
    // All or nothing: the unchanged one stayed too.
    expect(vault.body.items.map((i) => i.id)).toContain(bank.id);
    expect(vault.body.items).toHaveLength(3);
  });

  it("refuses to remove when the vault is not the one packed", async () => {
    const { vault, bank } = seeded();
    const pkg = await packed(vault, [bank.id]);
    vault.createdAt = "2027-01-01T00:00:00.000Z";
    expect(await completeItemDeparture(vault.deps, pkg, ACK)).toMatchObject({
      ok: false,
      code: "vault_changed",
    });
  });

  it("stops with nothing taken when a trace cannot be dropped first", async () => {
    const { vault, bank } = seeded();
    const pkg = await packed(vault, [bank.id]);
    vault.failPurge.add("activity");
    expect(await completeItemDeparture(vault.deps, pkg, ACK)).toMatchObject({
      ok: false,
      code: "purge_failed",
    });
    expect(vault.body.items.map((i) => i.id)).toContain(bank.id);
  });

  it("finishes from the same package when a purge failed after the removal", async () => {
    const { vault, bank } = seeded();
    const pkg = await packed(vault, [bank.id]);
    // Fine before the mutation, broken after it: a removal cut short.
    vault.failOnCall.set("passwords", 2);
    const first = await completeItemDeparture(vault.deps, pkg, ACK);
    expect(first).toMatchObject({
      ok: true,
      receipt: { completion: "incomplete", incomplete: ["passwords"] },
    });
    expect(vault.body.items.map((i) => i.id)).not.toContain(bank.id);
    const second = await completeItemDeparture(vault.deps, pkg, ACK);
    expect(second).toMatchObject({
      ok: true,
      receipt: { completion: "applied_local", incomplete: [] },
    });
  });
});

describe("returning items", () => {
  async function hidden(ids: (v: ReturnType<typeof seeded>) => string[]) {
    const s = seeded();
    const pkg = await packed(s.vault, ids(s));
    const original = structuredClone(s.vault.body);
    await completeItemDeparture(s.vault.deps, pkg, ACK);
    return { ...s, pkg, original };
  }

  async function opened(
    vault: ReturnType<typeof seeded>["vault"],
    pkg: ItemsPackage,
    code = pkg.returnCode,
  ) {
    return openItemsReturn(vault.deps, {
      bundleJson: pkg.bundleJson,
      returnCode: code,
    });
  }

  it("brings back the very items: ids, times, folder, and a folder that left", async () => {
    const { vault, pkg, original, bank, mail } = await hidden((s) => [
      s.bank.id,
      s.mail.id,
    ]);
    const out = await opened(vault, pkg);
    if (!out.ok) throw new Error(out.code);
    expect(out.opened.preview.items.map((i) => [i.label, i.status])).toEqual([
      ["Bank", "returns"],
      ["Mail", "returns"],
    ]);
    const back = await completeItemsReturn(vault.deps, out.opened);
    expect(back).toMatchObject({ ok: true });
    const byId = (id: string) => vault.body.items.find((i) => i.id === id);
    expect(byId(bank.id)).toEqual(original.items.find((i) => i.id === bank.id));
    expect(byId(mail.id)).toEqual(original.items.find((i) => i.id === mail.id));
    expect(vault.body.folders.map((f) => f.id).sort()).toEqual(
      original.folders.map((f) => f.id).sort(),
    );
    expect(vault.body.tombstones).toBeUndefined();
  });

  it("is idempotent: returning twice never duplicates", async () => {
    const { vault, pkg, bank } = await hidden((s) => [s.bank.id]);
    const out = await opened(vault, pkg);
    if (!out.ok) throw new Error(out.code);
    await completeItemsReturn(vault.deps, out.opened);
    const again = await opened(vault, pkg);
    if (!again.ok) throw new Error(again.code);
    expect(again.opened.preview.items[0]?.status).toBe("already_back");
    const second = await completeItemsReturn(vault.deps, again.opened);
    expect(second).toMatchObject({
      ok: true,
      receipt: { returned: [], alreadyBack: [bank.id] },
    });
    expect(vault.body.items.filter((i) => i.id === bank.id)).toHaveLength(1);
  });

  it("refuses a wrong code, a typo, a tampered bundle and another vault, changing nothing", async () => {
    const { vault, pkg, bank } = await hidden((s) => [s.bank.id]);
    const before = JSON.stringify(vault.body);
    expect(
      await opened(vault, pkg, "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA"),
    ).toMatchObject({ ok: false });
    expect(await opened(vault, pkg, "ABCD")).toMatchObject({
      ok: false,
      code: "code_malformed",
    });
    const flipped = JSON.parse(pkg.bundleJson);
    flipped.sealed.ctB64 = `${flipped.sealed.ctB64.slice(0, -4)}AAAA`;
    expect(
      await openItemsReturn(vault.deps, {
        bundleJson: JSON.stringify(flipped),
        returnCode: pkg.returnCode,
      }),
    ).toMatchObject({ ok: false, code: "code_mismatch" });
    expect(
      await openItemsReturn(vault.deps, {
        bundleJson: "{}",
        returnCode: pkg.returnCode,
      }),
    ).toMatchObject({ ok: false, code: "bundle_malformed" });
    vault.createdAt = "2027-03-03T00:00:00.000Z";
    expect(await opened(vault, pkg)).toMatchObject({
      ok: false,
      code: "other_vault",
    });
    expect(JSON.stringify(vault.body)).toBe(before);
    expect(vault.body.items.some((i) => i.id === bank.id)).toBe(false);
  });

  it("refuses when the vault holds that id with other content", async () => {
    const { vault, pkg, bank } = await hidden((s) => [s.bank.id]);
    const out = await opened(vault, pkg);
    if (!out.ok) throw new Error(out.code);
    vault.body.items.push({ ...bank, name: "Someone else's Bank" });
    const before = JSON.stringify(vault.body);
    expect(await completeItemsReturn(vault.deps, out.opened)).toMatchObject({
      ok: false,
      code: "occupied",
      ids: [bank.id],
    });
    expect(JSON.stringify(vault.body)).toBe(before);
  });

  it("refuses the gates and a vault bundle opened as items", async () => {
    const { vault, pkg } = await hidden((s) => [s.bank.id]);
    vault.duress = true;
    expect(await opened(vault, pkg)).toMatchObject({
      ok: false,
      code: "duress_active",
    });
    vault.duress = false;
    vault.owner = false;
    expect(await opened(vault, pkg)).toMatchObject({
      ok: false,
      code: "owner_not_present",
    });
  });

  it("leaves no activity line behind: a return never calls the log", async () => {
    const { vault, pkg } = await hidden((s) => [s.bank.id]);
    const before = vault.purged.activity.length;
    const out = await opened(vault, pkg);
    if (!out.ok) throw new Error(out.code);
    await completeItemsReturn(vault.deps, out.opened);
    expect(vault.purged.activity).toHaveLength(before);
  });
});
