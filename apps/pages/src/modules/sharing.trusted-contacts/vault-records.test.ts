/**
 * The records of a circle as items of the open vault: the real vault store,
 * the real item types, and records the desk itself would save. What is held
 * here is a signing key and a wrapped share, so the tests also look at where
 * they are not.
 */
import { toB64url } from "@opensesame/app-core/lib/quorum/bytes.js";
import { DeskError } from "@opensesame/app-core/lib/quorum/desk/ports.js";
import {
  GUARDIAN_SHARE_TYPE,
  TRUSTED_CIRCLE_TYPE,
} from "@opensesame/app-core/lib/quorum/records.js";
import type { VaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { type TypedItem, itemTypeRegistry } from "@opensesame/vault-core";
import type { FieldValues } from "@opensesame/vault-item-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RecordsVault, vaultRecordStore } from "./vault-records.js";
import {
  closeVault,
  openVault,
  records,
} from "./vault-records.test-support.js";

let store: VaultStore;

beforeEach(async () => {
  store = await openVault();
});

afterEach(async () => {
  await closeVault(store);
});

/** The typed items of one type, trashed ones too. */
function itemsOfType(typeId: string): TypedItem[] {
  return store
    .getSnapshot()
    .items.filter(
      (item): item is TypedItem =>
        item.kind === "typed" && item.typeId === typeId,
    );
}

function only(typeId: string): TypedItem {
  const [item, ...rest] = itemsOfType(typeId);
  if (!item || rest.length > 0) throw new Error(`not exactly one ${typeId}`);
  return item;
}

describe("an owner's circle", () => {
  it("round-trips, with the key in the item's concealed value and nowhere else", async () => {
    const { owned } = await records();
    const kept = vaultRecordStore(store);
    await kept.saveOwned(owned);

    const [back] = await kept.owned();
    expect(back?.signedPolicy.digest).toBe(owned.signedPolicy.digest);
    expect(back?.ownerSecretKey).toEqual(owned.ownerSecretKey);
    expect(back?.state).toBe(owned.state);

    const item = only(TRUSTED_CIRCLE_TYPE);
    const key = toB64url(owned.ownerSecretKey);
    expect(item.values.ownerKey).toBe(key);
    expect(item.name).toBe(owned.signedPolicy.policy.label);
    expect(item.values.circleId).toBe(owned.signedPolicy.policy.circleId);
    // Nothing else the item carries holds the key.
    const { ownerKey: _held, ...rest } = item.values;
    expect(JSON.stringify([item.name, rest])).not.toContain(key);
  });

  it("installs the item types on the first save, and the item reads as its type", async () => {
    const { owned } = await records();
    expect(itemTypeRegistry().has(TRUSTED_CIRCLE_TYPE)).toBe(false);
    await vaultRecordStore(store).saveOwned(owned);
    expect(itemTypeRegistry().has(TRUSTED_CIRCLE_TYPE)).toBe(true);
    expect(itemTypeRegistry().has(GUARDIAN_SHARE_TYPE)).toBe(true);
  });

  it("is updated in place, not duplicated, when it is saved again", async () => {
    const { owned } = await records();
    const kept = vaultRecordStore(store);
    await kept.saveOwned({ ...owned, state: "inviting" });
    const first = only(TRUSTED_CIRCLE_TYPE);
    await kept.saveOwned({ ...owned, state: "armed" });
    await kept.saveOwned({ ...owned, state: "recovering" });

    expect(itemsOfType(TRUSTED_CIRCLE_TYPE)).toHaveLength(1);
    expect(only(TRUSTED_CIRCLE_TYPE).id).toBe(first.id);
    expect((await kept.owned()).map((r) => r.state)).toEqual(["recovering"]);
  });

  it("keeps two circles apart, by circle id", async () => {
    const { owned, actionOwned } = await records();
    const kept = vaultRecordStore(store);
    await kept.saveOwned(owned);
    await kept.saveOwned(actionOwned);
    await kept.saveOwned({ ...owned, state: "armed" });
    expect(itemsOfType(TRUSTED_CIRCLE_TYPE)).toHaveLength(2);
    expect(
      (await kept.owned()).map((r) => r.signedPolicy.policy.circleId).sort(),
    ).toEqual(
      [owned, actionOwned].map((r) => r.signedPolicy.policy.circleId).sort(),
    );
  });

  it("is purged on removal, from the trash too", async () => {
    const { owned, actionOwned } = await records();
    const kept = vaultRecordStore(store);
    await kept.saveOwned(owned);
    await kept.saveOwned(actionOwned);
    // A copy someone trashed from the item editor still holds the key.
    const id = owned.signedPolicy.policy.circleId;
    const copy = itemsOfType(TRUSTED_CIRCLE_TYPE).find(
      (item) => item.values.circleId === id,
    );
    if (!copy) throw new Error("not saved");
    await store.trashItem(copy.id);
    expect(store.getSnapshot().items.some((i) => i.deletedAt !== null)).toBe(
      true,
    );
    await kept.removeOwned(id);

    expect(
      itemsOfType(TRUSTED_CIRCLE_TYPE).map((i) => i.values.circleId),
    ).toEqual([actionOwned.signedPolicy.policy.circleId]);
    expect(store.getSnapshot().items.some((i) => i.deletedAt !== null)).toBe(
      false,
    );
    expect((await kept.owned()).map((r) => r.signedPolicy.digest)).toEqual([
      actionOwned.signedPolicy.digest,
    ]);
    // Removing what is not there is not an error.
    await kept.removeOwned(id);
  });

  it("does not list a circle that was trashed", async () => {
    const { owned } = await records();
    const kept = vaultRecordStore(store);
    await kept.saveOwned(owned);
    await store.trashItem(only(TRUSTED_CIRCLE_TYPE).id);
    expect(await kept.owned()).toEqual([]);
    await kept.removeOwned(owned.signedPolicy.policy.circleId);
    expect(itemsOfType(TRUSTED_CIRCLE_TYPE)).toEqual([]);
  });
});

describe("what a guardian holds", () => {
  it("keeps a share with its holding, wrapped, and reads it back", async () => {
    const { share } = await records();
    const kept = vaultRecordStore(store);
    await kept.saveHeld(share);

    const [back] = await kept.held();
    expect(back?.holding?.wrapped.guardianId).toBe(
      share.holding?.wrapped.guardianId,
    );
    expect(back?.holding?.signedPolicy.digest).toBe(
      share.holding?.signedPolicy.digest,
    );
    expect(back?.seat.guardianId).toBe(share.seat.guardianId);
    expect(back?.receivingKey).toEqual(share.receivingKey);
    expect(back?.state).toBe("held");

    const item = only(GUARDIAN_SHARE_TYPE);
    expect(String(item.values.wrapped)).toContain(share.seat.guardianId);
    expect(item.values.receivingKey).toBe(
      toB64url(share.receivingKey ?? new Uint8Array()),
    );
    expect(item.values.circleId).toBe(share.seat.signedPolicy.policy.circleId);
  });

  it("keeps a seat with no share when the circle only approves actions", async () => {
    const { seat } = await records();
    expect(seat.holding).toBeNull();
    const kept = vaultRecordStore(store);
    await kept.saveHeld(seat);

    const [back] = await kept.held();
    expect(back?.holding).toBeNull();
    expect(back?.seat.guardianId).toBe(seat.seat.guardianId);
    expect(back?.seat.signedPolicy.digest).toBe(seat.seat.signedPolicy.digest);
    expect(back?.receivingKey).toEqual(seat.receivingKey);
    expect(only(GUARDIAN_SHARE_TYPE).values.wrapped).toBe("");
  });

  it("changes state in place, and keeps a name the person gave it", async () => {
    const { share } = await records();
    const kept = vaultRecordStore(store);
    await kept.saveHeld(share);
    const first = only(GUARDIAN_SHARE_TYPE);
    expect(first.values.owner).toBe(share.seat.signedPolicy.policy.label);

    await store.saveItem({
      ...first,
      values: { ...first.values, owner: "Tyler" },
    });
    await kept.saveHeld({ ...share, state: "approved" });
    await kept.saveHeld({ ...share, state: "released" });

    expect(itemsOfType(GUARDIAN_SHARE_TYPE)).toHaveLength(1);
    expect(only(GUARDIAN_SHARE_TYPE).id).toBe(first.id);
    expect(only(GUARDIAN_SHARE_TYPE).values.owner).toBe("Tyler");
    expect((await kept.held()).map((r) => r.state)).toEqual(["released"]);
  });

  it("is purged on leaving", async () => {
    const { share, seat } = await records();
    const kept = vaultRecordStore(store);
    await kept.saveHeld(share);
    await kept.saveHeld(seat);
    await kept.removeHeld(share.seat.signedPolicy.policy.circleId);
    expect((await kept.held()).map((r) => r.seat.guardianId)).toEqual([
      seat.seat.guardianId,
    ]);
    expect(itemsOfType(GUARDIAN_SHARE_TYPE)).toHaveLength(1);
  });

  it("refuses a share filed under another circle", async () => {
    const { share, seat } = await records();
    const kept = vaultRecordStore(store);
    await expect(
      kept.saveHeld({ ...share, seat: seat.seat }),
    ).rejects.toBeInstanceOf(DeskError);
    expect(itemsOfType(GUARDIAN_SHARE_TYPE)).toEqual([]);
  });

  it("does not mix a guardian's records with an owner's of the same circle", async () => {
    const { owned, share } = await records();
    const kept = vaultRecordStore(store);
    await kept.saveOwned(owned);
    await kept.saveHeld(share);
    expect(await kept.owned()).toHaveLength(1);
    expect(await kept.held()).toHaveLength(1);
    await kept.removeHeld(share.seat.signedPolicy.policy.circleId);
    expect(await kept.owned()).toHaveLength(1);
  });
});

describe("a record that cannot be read", () => {
  async function saved() {
    const { owned, actionOwned, share } = await records();
    const kept = vaultRecordStore(store);
    await kept.saveOwned(owned);
    await kept.saveOwned(actionOwned);
    await kept.saveHeld(share);
    return { kept, owned, actionOwned, share };
  }

  function edit(circleId: string, change: FieldValues) {
    const item = itemsOfType(TRUSTED_CIRCLE_TYPE).find(
      (found) => found.values.circleId === circleId,
    );
    if (!item) throw new Error("no such circle");
    return store.saveItem({ ...item, values: { ...item.values, ...change } });
  }

  it("is reported, not thrown, and the good ones still come back", async () => {
    const { kept, owned, actionOwned } = await saved();
    const circleId = owned.signedPolicy.policy.circleId;
    const item = only(GUARDIAN_SHARE_TYPE);
    await edit(circleId, {
      policy: String(
        itemsOfType(TRUSTED_CIRCLE_TYPE).find(
          (i) => i.values.circleId === circleId,
        )?.values.policy,
      ).replace('"epoch":1', '"epoch":2'),
    });

    const good = await kept.owned();
    expect(good.map((r) => r.signedPolicy.policy.circleId)).toEqual([
      actionOwned.signedPolicy.policy.circleId,
    ]);
    expect(await kept.unreadable()).toEqual([
      {
        itemId: expect.any(String),
        type: "owned",
        name: owned.signedPolicy.policy.label,
        circleId,
        reason: "policy",
      },
    ]);
    // The share is untouched.
    expect(await kept.held()).toHaveLength(1);
    expect(item.id).toBe(only(GUARDIAN_SHARE_TYPE).id);
  });

  it("tells a policy that does not verify from one that does not read, and quotes neither", async () => {
    const { kept, owned, actionOwned } = await saved();
    await edit(owned.signedPolicy.policy.circleId, {
      policy: "{ this is not json",
    });
    await edit(actionOwned.signedPolicy.policy.circleId, {
      status: "dissolved",
    });
    expect(await kept.owned()).toEqual([]);
    const reasons = (await kept.unreadable()).map((r) => r.reason);
    expect(reasons).toEqual(["format", "format"]);
    const report = JSON.stringify(await kept.unreadable());
    expect(report).not.toContain("this is not json");
    expect(report).not.toContain(toB64url(owned.ownerSecretKey));
  });

  it("is replaced, not duplicated, when the circle is saved again", async () => {
    const { kept, owned } = await saved();
    await edit(owned.signedPolicy.policy.circleId, { policy: "garbage" });
    expect(await kept.unreadable()).toHaveLength(1);
    await kept.saveOwned(owned);
    expect(await kept.unreadable()).toEqual([]);
    expect(itemsOfType(TRUSTED_CIRCLE_TYPE)).toHaveLength(2);
  });

  it("is reported for a share too", async () => {
    const { kept, share } = await saved();
    const item = only(GUARDIAN_SHARE_TYPE);
    await store.saveItem({
      ...item,
      values: { ...item.values, wrapped: "{}" },
    });
    expect(await kept.held()).toEqual([]);
    expect(await kept.unreadable()).toMatchObject([
      {
        type: "held",
        circleId: share.seat.signedPolicy.policy.circleId,
        reason: "format",
      },
    ]);
  });
});

describe("a write that meets another tab's change", () => {
  /** A store whose first `failures` saves are refused as a stale update is. */
  function refusing(failures: number): RecordsVault {
    let left = failures;
    return {
      getSnapshot: () => store.getSnapshot(),
      installItemTypeDefinition: (text) =>
        store.installItemTypeDefinition(text),
      purgeItem: (id) => store.purgeItem(id),
      saveItem: async (item, folder) => {
        if (left > 0) {
          left -= 1;
          throw new Error(
            "The item changed or left the vault before this update.",
          );
        }
        await store.saveItem(item, folder);
      },
    };
  }

  it("is tried once more against the items as they are by then", async () => {
    const { owned } = await records();
    await vaultRecordStore(refusing(1)).saveOwned(owned);
    expect(itemsOfType(TRUSTED_CIRCLE_TYPE)).toHaveLength(1);
  });

  it("is not tried a third time", async () => {
    const { owned } = await records();
    await expect(
      vaultRecordStore(refusing(2)).saveOwned(owned),
    ).rejects.toThrow("changed or left the vault");
    expect(itemsOfType(TRUSTED_CIRCLE_TYPE)).toEqual([]);
  });

  it("reads the item again before the retry", async () => {
    const { owned } = await records();
    const kept = vaultRecordStore(store);
    await kept.saveOwned({ ...owned, state: "inviting" });
    let seen: string[] = [];
    const racing: RecordsVault = {
      ...refusing(0),
      saveItem: async (item, folder) => {
        seen = [...seen, item.id];
        if (seen.length === 1) {
          // Another tab replaced the item between the read and the write.
          const current = only(TRUSTED_CIRCLE_TYPE);
          await store.saveItem({
            ...current,
            values: { ...current.values, status: "recovering" },
          });
          throw new Error(
            "The item changed or left the vault before this update.",
          );
        }
        await store.saveItem(item, folder);
      },
    };
    await vaultRecordStore(racing).saveOwned({ ...owned, state: "armed" });
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(1);
    expect((await kept.owned()).map((r) => r.state)).toEqual(["armed"]);
  });
});
