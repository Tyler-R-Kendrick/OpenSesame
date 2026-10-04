import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** The selector lists of every rule that styles a toggle in its on state. */
function onRules(): string[] {
  return css
    .split("{")
    .map((chunk) => chunk.slice(chunk.lastIndexOf("}") + 1).trim())
    .filter((selectors) => selectors.includes(".toggle[aria-"));
}

describe("a switch looks on when it says aria-checked", () => {
  it("styles the on state for aria-checked as well as aria-pressed, in every rule that does either", () => {
    const rules = onRules();
    expect(rules.length).toBeGreaterThanOrEqual(5);
    for (const selectors of rules) {
      const pressed = selectors.includes('.toggle[aria-pressed="true"]');
      const checked = selectors.includes('.toggle[aria-checked="true"]');
      expect(pressed && checked, selectors).toBe(true);
    }
  });
});
