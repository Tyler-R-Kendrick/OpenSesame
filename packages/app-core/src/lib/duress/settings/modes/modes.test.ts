import { findForbiddenClaims } from "@opensesame/contracts";
import { createItem } from "@opensesame/vault-core";
import { describe, expect, it } from "vitest";
import {
  MODES,
  decodePlan,
  encodePlan,
  getMode,
  hasEffectRunner,
  inputReady,
  isOffered,
  offeredModes,
} from "./index.js";
import type { ModeExtras } from "./inputs.js";
import type { DuressContext, DuressMode } from "./mode.js";

/** Every mode, read through the contract a caller sees. */
const ALL: readonly DuressMode[] = MODES;

/** A vault with a few items worth showing, so a mode that picks among them has rows. */
const CONTEXT: DuressContext = {
  items: [createItem("login", "Netflix"), createItem("note", "Gym code")],
};

const position = (id: string) => MODES.findIndex((mode) => mode.id === id);

/** A value that satisfies whatever input the mode declares. */
function sampleExtras(mode: DuressMode): ModeExtras {
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
    case "pick":
      return {
        [input.id]: (mode.rows?.(CONTEXT) ?? [])
          .slice(0, input.min)
          .map((row) => row.id)
          .join("\n"),
      };
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

  it("has unique ids, and every mode this registry is known by", () => {
    const ids = MODES.map((mode) => mode.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(
      [
        "decoy",
        "decoy_items",
        "freeze",
        "refuse",
        "visible_items",
        "wipe",
      ].sort(),
    );
  });

  it("draws what a person can show before what refuses them", () => {
    // Relative places, so another mode landing between them breaks nothing:
    // a compelled person is given something to show before they are given a
    // refusal (ADR 0168).
    const refusals = ["refuse", "freeze", "wipe"].map(position);
    for (const open of ["decoy", "visible_items", "decoy_items"]) {
      for (const refusal of refusals) {
        expect(position(open)).toBeGreaterThanOrEqual(0);
        expect(position(open)).toBeLessThan(refusal);
      }
    }
  });

  it("seals only the strings existing enrollments hold, and the refusals seal locked", () => {
    for (const mode of MODES) {
      expect(["decoy", "locked"]).toContain(mode.presentation);
    }
    for (const id of ["decoy", "visible_items", "decoy_items"]) {
      expect(getMode(id)?.presentation).toBe("decoy");
    }
    for (const id of ["refuse", "freeze", "wipe"]) {
      expect(getMode(id)?.presentation).toBe("locked");
    }
  });

  it("says plainly, in the sentence ticked, that a refusal can escalate", () => {
    for (const id of ["refuse", "freeze", "wipe"]) {
      const { consent } = getMode(id) ?? { consent: "" };
      expect(consent).toMatch(/refusing to comply/);
      expect(consent).toMatch(/escalate/);
    }
    for (const id of ["decoy", "visible_items", "decoy_items"]) {
      expect(getMode(id)?.consent).not.toMatch(/escalate/);
    }
  });

  it("makes no promise of safety, in any sentence a mode ticks", () => {
    for (const mode of MODES) {
      expect(findForbiddenClaims(mode.consent)).toEqual([]);
      expect(findForbiddenClaims(mode.opens)).toEqual([]);
      expect(mode.consent).not.toMatch(/\bsafe\b|\bprotect(s|ed)?\b/i);
    }
  });

  it("never promises an effect unlock cannot run", () => {
    // A mode's plan names the effect sealed with the code. If unlock has no
    // runner for it, arming would offer a switch that does nothing.
    for (const mode of ALL) {
      if (!mode.plan) continue;
      const extras = sampleExtras(mode);
      expect(inputReady(mode, extras)).toBe(true);
      const plan = mode.plan(extras, CONTEXT);
      expect(hasEffectRunner(plan.effect)).toBe(true);
      expect(decodePlan(encodePlan(plan))).toEqual(plan);
    }
  });

  it("gives every input its own id across modes, so extras never collide", () => {
    const ids = ALL.flatMap((mode) =>
      mode.input.kind === "none" ? [] : [mode.input.id],
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("offers a mode that picks only where it has rows, and every other always", () => {
    const empty: DuressContext = { items: [] };
    expect(offeredModes(MODES, empty).map((mode) => mode.id)).not.toContain(
      "visible_items",
    );
    expect(offeredModes(MODES, CONTEXT).map((mode) => mode.id)).toContain(
      "visible_items",
    );
    // The rest of the registry does not depend on the vault.
    expect(offeredModes(MODES, empty).map((mode) => mode.id)).toEqual(
      MODES.filter((mode) => mode.id !== "visible_items").map(
        (mode) => mode.id,
      ),
    );
    const visible = getMode("visible_items");
    if (!visible) throw new Error("no visible_items mode");
    expect(isOffered(visible, empty)).toBe(false);
    expect(isOffered(visible, CONTEXT)).toBe(true);
  });

  it("finds a mode by id and nothing for an unknown one", () => {
    expect(getMode("decoy")?.presentation).toBe("decoy");
    expect(getMode("refuse")?.presentation).toBe("locked");
    expect(getMode("wipe")?.presentation).toBe("locked");
    expect(getMode("")).toBeUndefined();
    expect(getMode("toString")).toBeUndefined();
  });
});
