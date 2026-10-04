import { describe, expect, it } from "vitest";

import { AUTHORED_GUIDE_LIMITS, GUIDE_LIMITS } from "./ast.js";
import { parseGuide } from "./parse.js";
import { compileGuide } from "./validate.js";

/** A program of `count` narrated steps. */
function tutorial(count: number): string {
  return [
    "guide/1",
    'goal "vault.item.create"',
    ...Array.from({ length: count }, (_, index) => `say "Step ${index + 1}."`),
    "end",
  ].join("\n");
}

describe("the budget a program is read under", () => {
  it("holds a model's trajectory to eight instructions", () => {
    expect(parseGuide(tutorial(7)).ok).toBe(true);
    const long = parseGuide(tutorial(12));
    expect(long.ok).toBe(false);
    expect(long.ok ? [] : long.errors.map((error) => error.code)).toContain(
      "too_many_instructions",
    );
  });

  it("lets a checked-in tutorial run longer, and no further than its own budget", () => {
    expect(parseGuide(tutorial(12), AUTHORED_GUIDE_LIMITS).ok).toBe(true);
    expect(parseGuide(tutorial(39), AUTHORED_GUIDE_LIMITS).ok).toBe(true);
    const over = parseGuide(
      tutorial(AUTHORED_GUIDE_LIMITS.maxInstructions + 1),
      AUTHORED_GUIDE_LIMITS,
    );
    expect(over.ok).toBe(false);
  });

  it("widens only the size: the text budget and the timeout range are the same", () => {
    expect(AUTHORED_GUIDE_LIMITS.maxMessageChars).toBe(
      GUIDE_LIMITS.maxMessageChars,
    );
    expect(AUTHORED_GUIDE_LIMITS.minTimeoutMs).toBe(GUIDE_LIMITS.minTimeoutMs);
    expect(AUTHORED_GUIDE_LIMITS.maxTimeoutMs).toBe(GUIDE_LIMITS.maxTimeoutMs);
    const wordy = [
      "guide/1",
      'goal "vault.item.create"',
      `say "${"x".repeat(GUIDE_LIMITS.maxMessageChars + 1)}"`,
    ].join("\n");
    expect(parseGuide(wordy, AUTHORED_GUIDE_LIMITS).ok).toBe(false);
  });

  it("is chosen by the caller of the compiler, never by the program", () => {
    const vocabulary = {
      goals: ["vault.item.create"],
      targets: [],
      routes: [],
      predicates: [],
    };
    expect(compileGuide(tutorial(12), vocabulary).ok).toBe(false);
    expect(
      compileGuide(tutorial(12), vocabulary, AUTHORED_GUIDE_LIMITS).ok,
    ).toBe(true);
  });

  it("refuses a program that is too many bytes or lines for its budget", () => {
    const tall = tutorial(5).split("\n").concat(Array(120).fill("")).join("\n");
    expect(parseGuide(tall, AUTHORED_GUIDE_LIMITS).ok).toBe(false);
  });
});
