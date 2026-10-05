import type { BoundaryValue } from "@opensesame/os-domain";
import { type VaultItem, createItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import { MAX_SLOT_PAYLOAD_BYTES } from "../../crypto/slot-profile.js";
import { hasEffectRunner } from "./effects.js";
import { inputReady } from "./inputs.js";
import { decodePlan, encodePlan } from "./payload.js";
import { VISIBLE_LIMITS, readVisibleItemsBody } from "./visible-items-shape.js";
import {
  HIDDEN,
  account,
  ctx,
  extrasFor,
  items,
} from "./visible-items.fixture.js";
import { VISIBLE_ITEMS } from "./visible-items.js";

describe("visible items plan", () => {
  it("copies exactly the items left shown, in the vault's order", () => {
    const list = items();
    const shown = [list[3], list[0], list[2]].filter(
      (item): item is VaultItem => item !== undefined,
    );
    const plan = VISIBLE_ITEMS.plan(extrasFor(shown), ctx(list));
    expect(plan.effect).toBe("visible_items");
    expect(hasEffectRunner(plan.effect)).toBe(true);
    const read = readVisibleItemsBody(plan.body);
    expect(read?.map((item) => item.name)).toEqual([
      "Netflix",
      "Gym code",
      "Wi-Fi",
    ]);
  });

  it("holds back everything not named: nothing hidden is in the sealed plan", () => {
    const list = items();
    const netflix = list.filter((item) => item.name === "Netflix");
    const plan = VISIBLE_ITEMS.plan(extrasFor(netflix), ctx(list));
    const bytes = new TextDecoder().decode(encodePlan(plan));
    expect(bytes).toContain("Netflix");
    for (const hidden of [
      "Hidden Bank",
      HIDDEN,
      "Gym code",
      "Visa",
      "s-value",
    ]) {
      expect(bytes).not.toContain(hidden);
    }
    expect(decodePlan(encodePlan(plan))).toEqual(plan);
  });

  it("is a pure function of its extras and the items it is handed", () => {
    const list = items();
    const extras = extrasFor(list.slice(0, 2));
    expect(VISIBLE_ITEMS.plan(extras, ctx(list))).toEqual(
      VISIBLE_ITEMS.plan(extras, ctx(list)),
    );
    const before = JSON.stringify(list);
    VISIBLE_ITEMS.plan(extras, ctx(list));
    expect(JSON.stringify(list)).toBe(before);
  });

  it("refuses to seal a plan that shows nothing, or only what is not shareable", () => {
    const list = items();
    expect(() => VISIBLE_ITEMS.plan({ shown: "" }, ctx(list))).toThrow();
    expect(() =>
      VISIBLE_ITEMS.plan({ shown: "no-such-id" }, ctx(list)),
    ).toThrow();
    const passkey = createItem("passkey", "Passkey");
    expect(() =>
      VISIBLE_ITEMS.plan({ shown: passkey.id }, ctx([...list, passkey])),
    ).toThrow();
    expect(() =>
      VISIBLE_ITEMS.plan({ shown: list[0]?.id ?? "" }, ctx([])),
    ).toThrow();
  });

  it("skips an id that is stale, so a stale pick can only hide", () => {
    const list = items();
    const plan = VISIBLE_ITEMS.plan(
      { shown: `${list[0]?.id}\nstale-id` },
      ctx(list),
    );
    expect(readVisibleItemsBody(plan.body)?.map((i) => i.name)).toEqual([
      "Netflix",
    ]);
  });

  it("asks for one or more picks, no repeats and no more than it can hold", () => {
    expect(inputReady(VISIBLE_ITEMS, {})).toBe(false);
    expect(inputReady(VISIBLE_ITEMS, { shown: "" })).toBe(false);
    expect(inputReady(VISIBLE_ITEMS, { shown: "a" })).toBe(true);
    expect(inputReady(VISIBLE_ITEMS, { shown: "a\na" })).toBe(false);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `id${i}`).join("\n");
    expect(inputReady(VISIBLE_ITEMS, { shown: many(VISIBLE_LIMITS.max) })).toBe(
      true,
    );
    expect(
      inputReady(VISIBLE_ITEMS, { shown: many(VISIBLE_LIMITS.max + 1) }),
    ).toBe(false);
  });

  it("fits the slot at its worst case, and says too large rather than truncating a plan", () => {
    const big = (n: number): VaultItem[] =>
      Array.from({ length: n }, (_, i) =>
        account(`Item ${i}`, {
          username: "€".repeat(VISIBLE_LIMITS.text),
          password: "€".repeat(VISIBLE_LIMITS.text),
          notes: "€".repeat(VISIBLE_LIMITS.notes),
        }),
      );
    const small = big(4);
    const plan = VISIBLE_ITEMS.plan(extrasFor(small), ctx(small));
    expect(encodePlan(plan).length).toBeLessThanOrEqual(MAX_SLOT_PAYLOAD_BYTES);
    const all = big(VISIBLE_LIMITS.max);
    expect(() =>
      encodePlan(VISIBLE_ITEMS.plan(extrasFor(all), ctx(all))),
    ).toThrow(/too large/);
  });
});

describe("visible items body reader", () => {
  const good = () => {
    const list = items();
    return VISIBLE_ITEMS.plan(extrasFor(list), ctx(list)).body;
  };
  const clone = (): { v: number; items: Record<string, BoundaryValue>[] } =>
    JSON.parse(JSON.stringify(good()));

  it("reads exactly what the mode seals", () => {
    expect(readVisibleItemsBody(good())?.map((i) => i.kind)).toEqual([
      "login",
      "login",
      "note",
      "secret",
      "card",
    ]);
  });

  it("is nothing for a body that is not exactly ours", () => {
    const mutations: ((body: ReturnType<typeof clone>) => BoundaryValue)[] = [
      (b) => ({ ...b, extra: 1 }),
      (b) => ({ ...b, v: 2 }),
      (b) => ({ v: 1 }),
      (b) => ({ ...b, items: [] }),
      (b) => ({ ...b, items: "x" }),
      (b) => ({ ...b, items: Array(VISIBLE_LIMITS.max + 1).fill(b.items[0]) }),
      (b) => ({ ...b, items: [{ ...b.items[0], totp: "SEED" }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], folderId: "f" }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], id: "real-id" }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], kind: "passkey" }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], kind: "certificate" }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], kind: "drop" }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], kind: "file" }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], name: "" }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], name: "a\nb" }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], name: "x".repeat(121) }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], password: 5 }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], password: "p".repeat(513) }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], notes: "n".repeat(4001) }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], favorite: "yes" }] }),
      (b) => ({ ...b, items: [{ ...b.items[0], createdAt: "tomorrow-ish" }] }),
      (b) => ({
        ...b,
        items: [{ ...b.items[0], uris: [{ uri: "u", match: "x" }] }],
      }),
      (b) => ({
        ...b,
        items: [
          { ...b.items[0], uris: [{ uri: "u", match: "host", id: "i" }] },
        ],
      }),
      (b) => ({
        ...b,
        items: [{ ...b.items[0], fields: [{ name: "n", value: "v" }] }],
      }),
      (b) => ({
        ...b,
        items: [
          {
            ...b.items[0],
            fields: Array(21).fill({ name: "n", value: "v", hidden: false }),
          },
        ],
      }),
      (b) => ({ ...b, items: [...b.items.slice(0, 1), "plain string"] }),
      (b) => ({ ...b, items: [...b.items.slice(0, 1), null] }),
      (b) => ({
        ...b,
        items: [
          { ...b.items[0], kind: "typed", typeId: "x", values: { a: 3 } },
        ],
      }),
    ];
    for (const mutate of mutations) {
      const mutated = mutate(clone());
      // A mutation that happens to leave a valid body would hide a gap.
      expect(readVisibleItemsBody(mutated)).toBeNull();
    }
    const notObjects: BoundaryValue[] = [null, undefined, "items", 42, []];
    for (const body of notObjects) {
      expect(readVisibleItemsBody(body)).toBeNull();
    }
  });

  it("refuses a typed value that would reach a prototype, and a record that is dressed", () => {
    const typed = (values: BoundaryValue) => ({
      v: 1,
      items: [
        {
          ...clone().items[0],
          kind: "typed",
          typeId: "x",
          values,
          username: undefined,
          password: undefined,
          passwordChangedAt: undefined,
          uris: undefined,
        },
      ],
    });
    const stripped = (body: ReturnType<typeof typed>) =>
      JSON.parse(JSON.stringify(body));
    expect(readVisibleItemsBody(stripped(typed({ a: "b" })))).not.toBeNull();
    expect(
      readVisibleItemsBody(
        JSON.parse(
          '{"v":1,"items":[{"kind":"typed","typeId":"x","name":"n","favorite":false,"notes":"","fields":[],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","values":{"__proto__":"x"}}]}',
        ),
      ),
    ).toBeNull();
    class Dressed {}
    expect(
      readVisibleItemsBody(
        Object.assign(Object.create(Dressed.prototype), { v: 1, items: [] }),
      ),
    ).toBeNull();
    expect(
      readVisibleItemsBody(Object.create({ v: 1, items: good() })),
    ).toBeNull();
  });
});
