import { expect, it } from "vitest";
import { extractSupportSources } from "./sources.js";

it("extracts adversarial citation suffixes and preserves legitimate citations", () => {
  expect(
    extractSupportSources(`Answer\n Sources: [guide.one], 'guide.two' `),
  ).toEqual({ answer: "Answer", cited: ["guide.one", "guide.two"] });
  expect(
    extractSupportSources(`Answer\nSources: ${"*".repeat(200_000)}!`),
  ).toEqual({ answer: "Answer", cited: ["!"] });
  expect(
    extractSupportSources(`Answer\nsources${" ".repeat(200_000)}!`).cited,
  ).toBe(null);
});

it.each(["\r", "\u2028", "\u2029"])(
  "keeps citations with a final line terminator uncited (%j)",
  (terminator) => {
    expect(
      extractSupportSources(`Answer\nSources: guide.one${terminator}`).cited,
    ).toBe(null);
  },
);
