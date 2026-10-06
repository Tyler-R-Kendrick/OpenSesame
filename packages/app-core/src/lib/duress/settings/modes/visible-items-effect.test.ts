import { type VaultItem, accountTotp } from "@opensesame/vault-core";
import { describe, expect, it, vi } from "vitest";
import { runDuressEffects } from "./effects.js";
import { VISIBLE_ITEMS_RUNNER, materialize } from "./visible-items-effect.js";
import { shareItem } from "./visible-items-share.js";
import { ctx, dressed, extrasFor, items } from "./visible-items.fixture.js";
import { VISIBLE_ITEMS } from "./visible-items.js";

describe("visible items runner", () => {
  const adder = () => vi.fn(async (_items: VaultItem[]) => undefined);
  const plan = () => {
    const list = items();
    return VISIBLE_ITEMS.plan(extrasFor(list.slice(0, 3)), ctx(list));
  };

  it("runs after the session exists, never before anything is shown", async () => {
    expect(VISIBLE_ITEMS_RUNNER.phase).toBe("after_session");
    const addItems = adder();
    await runDuressEffects(plan(), "on_match", { store: { addItems } });
    expect(addItems).not.toHaveBeenCalled();
    await runDuressEffects(plan(), "after_session", { store: { addItems } });
    expect(addItems).toHaveBeenCalledOnce();
  });

  it("adds each copy under an id of its own, in no folder, with no seed or history", async () => {
    const list = items();
    const built = VISIBLE_ITEMS.plan(extrasFor(list.slice(0, 3)), ctx(list));
    const addItems = adder();
    await VISIBLE_ITEMS_RUNNER.run(built.body, { store: { addItems } });
    const added = addItems.mock.calls[0]?.[0] ?? [];
    expect(added.map((item) => item.name)).toEqual([
      "Netflix",
      "Hidden Bank",
      "Gym code",
    ]);
    const realIds = new Set(list.map((item) => item.id));
    for (const item of added) {
      expect(realIds.has(item.id)).toBe(false);
      expect(item.folderId).toBeNull();
      expect(item.deletedAt).toBeNull();
    }
    expect(new Set(added.map((item) => item.id)).size).toBe(added.length);
    const first = added[0];
    expect(first?.kind === "account" && accountTotp(first)).toBe("");
    // A second run draws other ids: the ids are not sealed.
    const again = adder();
    await VISIBLE_ITEMS_RUNNER.run(built.body, { store: { addItems: again } });
    expect(again.mock.calls[0]?.[0].map((i) => i.id)).not.toEqual(
      added.map((i) => i.id),
    );
  });

  it("gives custom fields and links new ids too", () => {
    const original = dressed();
    const copy = shareItem(original);
    if (!copy) throw new Error("no copy");
    const made = materialize(copy);
    if (made.kind !== "account") throw new Error("not an account");
    expect(made.fields[0]?.id).not.toBe("f1");
    expect(made.uris[0]?.id).not.toBe("u1");
    expect(made.fields[0]).toMatchObject({ name: "Branch", value: "Downtown" });
    expect(made.favorite).toBe(true);
    expect(made.createdAt).toBe(original.createdAt);
  });

  it("does nothing, and does not throw, for a body that is not ours or a host with no store", async () => {
    const addItems = adder();
    for (const body of [
      null,
      {},
      { v: 1, items: [] },
      "x",
      { v: 1, items: [{}] },
    ]) {
      await expect(
        VISIBLE_ITEMS_RUNNER.run(body, { store: { addItems } }),
      ).resolves.toBeUndefined();
    }
    expect(addItems).not.toHaveBeenCalled();
    await expect(
      VISIBLE_ITEMS_RUNNER.run(plan().body, { store: {} }),
    ).resolves.toBeUndefined();
  });

  it("never lets a failing store out of the seam", async () => {
    const addItems = vi.fn(async () => {
      throw new Error("disk full");
    });
    await expect(
      runDuressEffects(plan(), "after_session", { store: { addItems } }),
    ).resolves.toBeUndefined();
    expect(addItems).toHaveBeenCalled();
  });
});
