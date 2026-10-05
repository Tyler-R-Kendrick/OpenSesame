import { describe, expect, it } from "vitest";
import { MODES, getMode } from "./index.js";

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
    expect(ids).toEqual(["decoy", "refuse"]);
  });

  it("seals only the strings existing enrollments hold", () => {
    expect(MODES.map((mode) => mode.presentation)).toEqual(["decoy", "locked"]);
  });

  it("declares no effect and no extra input yet", () => {
    for (const mode of MODES) {
      expect(mode.input).toEqual({ kind: "none" });
      expect("effect" in mode).toBe(false);
    }
  });

  it("finds a mode by id and nothing for an unknown one", () => {
    expect(getMode("decoy")?.presentation).toBe("decoy");
    expect(getMode("refuse")?.presentation).toBe("locked");
    expect(getMode("wipe")).toBeUndefined();
    expect(getMode("")).toBeUndefined();
    expect(getMode("toString")).toBeUndefined();
  });
});
