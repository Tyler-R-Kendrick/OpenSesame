import { describe, expect, it } from "vitest";
import {
  MODES,
  decodePlan,
  encodePlan,
  getMode,
  hasEffectRunner,
  inputReady,
} from "./index.js";
import type { DuressMode } from "./mode.js";

/** A value that satisfies whatever input the mode declares. */
function sampleExtras(mode: DuressMode): Record<string, string> {
  const { input } = mode;
  switch (input.kind) {
    case "none":
      return {};
    case "text":
      return { [input.id]: "x" };
    case "choice":
      return { [input.id]: input.options[0]?.value ?? "" };
    case "items":
      return { [input.id]: Array(input.min).fill("a").join("\n") };
    case "confirm":
      return { [input.id]: input.word };
  }
}

describe("duress mode registry", () => {
  it("gives every mode a label, an opens line and its own consent", () => {
    for (const mode of MODES) {
      expect(mode.label.trim()).not.toBe("");
      expect(mode.opens.trim()).not.toBe("");
      expect(mode.consent.trim()).not.toBe("");
    }
    expect(new Set(MODES.map((mode) => mode.consent)).size).toBe(MODES.length);
    expect(new Set(MODES.map((mode) => mode.label)).size).toBe(MODES.length);
  });

  it("has unique ids, in a stable order", () => {
    const ids = MODES.map((mode) => mode.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["decoy", "refuse", "freeze"]);
  });

  it("seals only the strings existing enrollments hold", () => {
    expect(MODES.map((mode) => mode.presentation)).toEqual([
      "decoy",
      "locked",
      "locked",
    ]);
  });

  it("never promises an effect unlock cannot run", () => {
    // A mode's plan names the effect sealed with the code. If unlock has no
    // runner for it, arming would offer a switch that does nothing.
    for (const mode of MODES as readonly DuressMode[]) {
      if (!mode.plan) continue;
      const extras = sampleExtras(mode);
      expect(inputReady(mode, extras)).toBe(true);
      const plan = mode.plan(extras);
      expect(hasEffectRunner(plan.effect)).toBe(true);
      expect(decodePlan(encodePlan(plan))).toEqual(plan);
    }
  });

  it("gives every input its own id across modes, so extras never collide", () => {
    const ids = (MODES as readonly DuressMode[]).flatMap((mode) =>
      mode.input.kind === "none" ? [] : [mode.input.id],
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("finds a mode by id and nothing for an unknown one", () => {
    expect(getMode("decoy")?.presentation).toBe("decoy");
    expect(getMode("refuse")?.presentation).toBe("locked");
    expect(getMode("wipe")).toBeUndefined();
    expect(getMode("")).toBeUndefined();
    expect(getMode("toString")).toBeUndefined();
  });
});
