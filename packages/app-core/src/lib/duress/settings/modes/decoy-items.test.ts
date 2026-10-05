import { describe, expect, it, vi } from "vitest";
import { MAX_SLOT_PAYLOAD_BYTES } from "../../crypto/slot-profile.js";
import { DECOY_ITEMS_RUNNER } from "./decoy-items-effect.js";
import {
  DECOY_ITEM_LIMITS,
  type DecoyItem,
  readDecoyItemsBody,
} from "./decoy-items-shape.js";
import { DECOY_ITEMS, randomDecoySecret } from "./decoy-items.js";
import { hasEffectRunner, runDuressEffects } from "./effects.js";
import { inputReady } from "./inputs.js";
import { decodePlan, encodePlan } from "./payload.js";

const plan = (items: string) => {
  const built = DECOY_ITEMS.plan({ items });
  return built.body as { items: DecoyItem[] };
};

describe("decoy items plan", () => {
  it("makes one item per line, trimmed, blanks dropped, in the owner's order", () => {
    const { items } = plan("  Netflix \n\n Wi-Fi at home\r\nGym\n");
    expect(items.map((item) => item.title)).toEqual([
      "Netflix",
      "Wi-Fi at home",
      "Gym",
    ]);
  });

  it("names the effect unlock runs, and unlock has a runner for it", () => {
    const built = DECOY_ITEMS.plan({ items: "a\nb\nc" });
    expect(built.effect).toBe("decoy_items");
    expect(hasEffectRunner(built.effect)).toBe(true);
    expect(DECOY_ITEMS_RUNNER.phase).toBe("after_session");
  });

  it("gives every item a random-looking secret of its own, none repeated", () => {
    const { items } = plan(
      Array.from({ length: 12 }, (_, n) => `t${n}`).join("\n"),
    );
    const secrets = items.map((item) => item.secret);
    expect(new Set(secrets).size).toBe(12);
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThanOrEqual(DECOY_ITEM_LIMITS.minSecret);
      expect(secret).not.toMatch(/\s/);
    }
  });

  it("draws different secrets at every arming, from the platform's random source", () => {
    const first = plan("a\nb\nc").items.map((item) => item.secret);
    const second = plan("a\nb\nc").items.map((item) => item.secret);
    expect(second).not.toEqual(first);
    const spy = vi.spyOn(crypto, "getRandomValues");
    randomDecoySecret();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("keeps a secret from ever being a title or holding one", () => {
    const { items } = plan("Netflix\nGym\nSpotify");
    for (const { title, secret } of items) {
      expect(secret).not.toContain(title);
      expect(title).not.toContain(secret);
    }
  });

  it("fits the slot at its worst case: 12 items, widest titles, widest secrets", () => {
    // Three UTF-8 bytes per unit is the widest a 40-unit title can be.
    const widest = "€".repeat(DECOY_ITEM_LIMITS.maxTitle);
    const lines = Array.from(
      { length: DECOY_ITEM_LIMITS.max },
      (_, n) => `${n.toString(16)}${widest.slice(1)}`,
    ).join("\n");
    const built = DECOY_ITEMS.plan({ items: lines });
    const bytes = encodePlan(built);
    expect(bytes.length).toBeLessThan(MAX_SLOT_PAYLOAD_BYTES);
    expect(bytes.length).toBeLessThan(MAX_SLOT_PAYLOAD_BYTES / 2);
    expect(decodePlan(bytes)).toEqual(built);
  });

  it("refuses lines that are not a decoy rather than sealing a plan that would not run", () => {
    expect(() => DECOY_ITEMS.plan({ items: "a\nb" })).toThrow();
    expect(() => DECOY_ITEMS.plan({ items: "" })).toThrow();
    expect(() =>
      DECOY_ITEMS.plan({
        items: Array.from({ length: 13 }, (_, n) => `t${n}`).join("\n"),
      }),
    ).toThrow();
    expect(() =>
      DECOY_ITEMS.plan({ items: `a\nb\n${"x".repeat(41)}` }),
    ).toThrow();
    // Only control characters: nothing a person could read as a title.
    expect(() => DECOY_ITEMS.plan({ items: "a\nb\n\u0000\u0007" })).toThrow();
  });

  it("collapses a title to one line of plain text", () => {
    const { items } = plan("Net\tflix‮\nB\u0000\nGym   club");
    expect(items.map((item) => item.title)).toEqual([
      "Net flix",
      "B",
      "Gym club",
    ]);
  });

  it("offers a starter that is ready as it stands and is ours alone", () => {
    const { input } = DECOY_ITEMS;
    expect(input.starter.length).toBeGreaterThanOrEqual(input.min);
    expect(inputReady(DECOY_ITEMS, { items: input.starter.join("\n") })).toBe(
      true,
    );
    expect(input.starter).toEqual(expect.arrayContaining(["Netflix", "Gym"]));
  });
});

const good = (n = 3): { items: DecoyItem[] } => ({
  items: Array.from({ length: n }, (_, i) => ({
    title: `Item ${i}`,
    secret: `s3cret-value-${i}-xyz`,
  })),
});

describe("decoy items body reader", () => {
  it("reads exactly what the mode seals", () => {
    const sealed = plan("a\nb\nc");
    expect(readDecoyItemsBody(sealed)).toEqual(sealed.items);
  });

  it("is nothing for a body that is not exactly ours", () => {
    const longTitle = good();
    longTitle.items[0] = {
      title: "x".repeat(41),
      secret: "s3cret-value-0-xyz",
    };
    const shortSecret = good();
    shortSecret.items[1] = { title: "ok", secret: "short" };
    const bad: unknown[] = [
      null,
      undefined,
      "items",
      42,
      [],
      {},
      { items: "a" },
      good(2),
      good(13),
      { ...good(), extra: 1 },
      {
        items: [
          ...good().items,
          { title: "t", secret: "s3cret-value-9-xyz", x: 1 },
        ],
      },
      { items: [...good().items.slice(1), "plain string"] },
      { items: [...good().items.slice(1), null] },
      {
        items: [
          ...good().items.slice(1),
          { title: 5, secret: "s3cret-value-9-xyz" },
        ],
      },
      {
        items: [
          ...good().items.slice(1),
          { title: "", secret: "s3cret-value-9-xyz" },
        ],
      },
      {
        items: [
          ...good().items.slice(1),
          { title: " padded ", secret: "s3cret-value-9-xyz" },
        ],
      },
      {
        items: [
          ...good().items.slice(1),
          { title: "a\nb", secret: "s3cret-value-9-xyz" },
        ],
      },
      {
        items: [
          ...good().items.slice(1),
          { title: "t", secret: "s3cret-\u0000value-9-xyz" },
        ],
      },
      longTitle,
      shortSecret,
    ];
    for (const body of bad) expect(readDecoyItemsBody(body)).toBeNull();
  });

  it("refuses a body that is not a plain object, however it is dressed", () => {
    class Dressed {
      items = good().items;
    }
    expect(readDecoyItemsBody(new Dressed())).toBeNull();
    expect(
      readDecoyItemsBody(Object.create({ items: good().items })),
    ).toBeNull();
  });
});

describe("decoy items runner", () => {
  const host = (addItems: ReturnType<typeof vi.fn>) => ({
    store: { addItems },
  });

  it("adds a login per item, titled and holding its secret, to the store it is given", async () => {
    const addItems = vi.fn(async () => undefined);
    const body = plan("Netflix\nGym\nSpotify");
    await DECOY_ITEMS_RUNNER.run(body, host(addItems));
    expect(addItems).toHaveBeenCalledOnce();
    const added = (addItems.mock.calls[0] as unknown[])[0] as {
      kind: string;
      name: string;
      password: string;
      deletedAt: null;
    }[];
    expect(added.map((item) => item.name)).toEqual([
      "Netflix",
      "Gym",
      "Spotify",
    ]);
    expect(added.map((item) => item.password)).toEqual(
      body.items.map((item) => item.secret),
    );
    for (const item of added) {
      expect(item.kind).toBe("login");
      expect(item.deletedAt).toBeNull();
    }
    expect(
      new Set(added.map((item) => (item as { id?: string }).id)).size,
    ).toBe(3);
  });

  it("does nothing for a body that is not exactly ours", async () => {
    const addItems = vi.fn(async () => undefined);
    for (const body of [
      null,
      {},
      good(2),
      good(13),
      { ...good(), x: 1 },
      "x",
    ]) {
      await expect(
        DECOY_ITEMS_RUNNER.run(body, host(addItems)),
      ).resolves.toBeUndefined();
    }
    expect(addItems).not.toHaveBeenCalled();
  });

  it("does nothing, and does not throw, for a host with no way to add items", async () => {
    await expect(
      DECOY_ITEMS_RUNNER.run(good(), { store: {} }),
    ).resolves.toBeUndefined();
  });

  it("never lets a failing store out of the seam", async () => {
    const addItems = vi.fn(async () => {
      throw new Error("disk full");
    });
    await expect(
      runDuressEffects(
        { effect: "decoy_items", body: good() },
        "after_session",
        host(addItems),
      ),
    ).resolves.toBeUndefined();
    expect(addItems).toHaveBeenCalled();
  });

  it("runs only after the session exists, never before anything is shown", async () => {
    const addItems = vi.fn(async () => undefined);
    await runDuressEffects(
      { effect: "decoy_items", body: good() },
      "on_match",
      host(addItems),
    );
    expect(addItems).not.toHaveBeenCalled();
    await runDuressEffects(
      { effect: "decoy_items", body: good() },
      "after_session",
      host(addItems),
    );
    expect(addItems).toHaveBeenCalledOnce();
  });
});
