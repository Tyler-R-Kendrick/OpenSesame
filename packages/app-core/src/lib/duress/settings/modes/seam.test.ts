import { describe, expect, it, vi } from "vitest";
import { MAX_SLOT_PAYLOAD_BYTES } from "../../crypto/slot-profile.js";
import { effectRunnerFor, runDuressEffects } from "./effects.js";
import { inputReady, itemLines } from "./inputs.js";
import type { DuressMode } from "./mode.js";
import { decodePlan, encodePlan } from "./payload.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("plan payload", () => {
  it("round-trips a plan", () => {
    const plan = { effect: "freeze", body: { hours: 24 } } as const;
    expect(decodePlan(encodePlan(plan))).toEqual(plan);
  });

  it("is no plan when there is nothing, or nothing it can read", () => {
    expect(decodePlan(null)).toBeNull();
    expect(decodePlan(undefined)).toBeNull();
    expect(decodePlan(new Uint8Array(0))).toBeNull();
    expect(decodePlan(bytes("not json"))).toBeNull();
    expect(decodePlan(bytes("null"))).toBeNull();
    expect(decodePlan(bytes("[1]"))).toBeNull();
    expect(decodePlan(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
  });

  it("is no plan for a version it does not know or an effect it has no name for", () => {
    expect(decodePlan(bytes('{"e":"freeze","v":2,"b":{}}'))).toBeNull();
    expect(decodePlan(bytes('{"e":"freeze","b":{}}'))).toBeNull();
    expect(decodePlan(bytes('{"e":"format_disk","v":1,"b":{}}'))).toBeNull();
    for (const inherited of ["toString", "constructor", "__proto__"]) {
      expect(decodePlan(bytes(`{"e":"${inherited}","v":1,"b":{}}`))).toBeNull();
    }
  });

  it("refuses to encode a plan that would not fit a slot", () => {
    expect(() =>
      encodePlan({
        effect: "decoy_items",
        body: "x".repeat(MAX_SLOT_PAYLOAD_BYTES),
      }),
    ).toThrow(/too large/);
  });
});

const mode = (input: DuressMode["input"]): DuressMode => ({
  id: "t",
  label: "t",
  opens: "t",
  consent: "t",
  presentation: "locked",
  input,
});

describe("input readiness", () => {
  it("needs nothing for none", () => {
    expect(inputReady(mode({ kind: "none" }), {})).toBe(true);
  });

  it("needs text to be more than padding", () => {
    const m = mode({ kind: "text", id: "t", label: "t" });
    expect(inputReady(m, {})).toBe(false);
    expect(inputReady(m, { t: "  " })).toBe(false);
    expect(inputReady(m, { t: "x" })).toBe(true);
  });

  it("needs a choice to be one of its options, never a value of its own", () => {
    const m = mode({
      kind: "choice",
      id: "c",
      label: "c",
      options: [
        { value: "1", label: "one" },
        { value: "24", label: "day" },
      ],
    });
    expect(inputReady(m, { c: "24" })).toBe(true);
    expect(inputReady(m, { c: "9999" })).toBe(false);
    expect(inputReady(m, {})).toBe(false);
  });

  it("needs items within the count and the length, blanks not counted", () => {
    const m = mode({
      kind: "items",
      id: "i",
      label: "i",
      min: 2,
      max: 3,
      maxLength: 5,
    });
    expect(itemLines(" a \n\n b\n")).toEqual(["a", "b"]);
    expect(inputReady(m, { i: "a" })).toBe(false);
    expect(inputReady(m, { i: "a\n\nb" })).toBe(true);
    expect(inputReady(m, { i: "a\nb\nc\nd" })).toBe(false);
    expect(inputReady(m, { i: "a\nbbbbbb" })).toBe(false);
  });

  it("needs a confirmation to be the word, however it is cased or padded", () => {
    const m = mode({ kind: "confirm", id: "w", label: "w", word: "WIPE" });
    expect(inputReady(m, { w: " wipe " })).toBe(true);
    expect(inputReady(m, { w: "wip" })).toBe(false);
    expect(inputReady(m, {})).toBe(false);
  });
});

describe("effect runner", () => {
  const plan = { effect: "freeze", body: { n: 1 } } as const;

  it("runs a runner in its own phase, with the plan's body and the host", async () => {
    const run = vi.fn(async () => undefined);
    const go = effectRunnerFor(
      new Map([["freeze", { phase: "on_match", run }]]),
    );
    const host = { store: {} };
    await go(plan, "after_session", host);
    expect(run).not.toHaveBeenCalled();
    await go(plan, "on_match", host);
    expect(run).toHaveBeenCalledWith({ n: 1 }, host);
  });

  it("does nothing for no plan or an effect with no runner", async () => {
    const run = vi.fn(async () => undefined);
    const go = effectRunnerFor(
      new Map([["freeze", { phase: "on_match", run }]]),
    );
    await go(null, "on_match", { store: {} });
    await go({ effect: "wipe", body: {} }, "on_match", { store: {} });
    expect(run).not.toHaveBeenCalled();
  });

  it("never lets a failing runner out: a visible failure would be the tell", async () => {
    const go = effectRunnerFor(
      new Map([
        [
          "freeze",
          {
            phase: "on_match",
            run: async () => {
              throw new Error("boom");
            },
          },
        ],
      ]),
    );
    await expect(go(plan, "on_match", { store: {} })).resolves.toBeUndefined();
  });

  it("ships with no runner for a name nobody registered", async () => {
    await expect(
      runDuressEffects({ effect: "freeze", body: {} }, "on_match", {
        store: {},
      }),
    ).resolves.toBeUndefined();
  });
});
