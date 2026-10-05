/**
 * What `coach.css` — the tutorial card's stylesheet — is allowed to touch.
 * Source-level assertions, like `stylesheet-contract.test.ts`: a card that
 * restyled `button` would change every control in the vault, and a glide that
 * ignored `prefers-reduced-motion` would move things for someone who asked
 * for stillness.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  anchor,
  declarations,
  parseRules,
  reduced,
  ruleFor,
} from "./css-contract.js";

const coachRules = parseRules(
  readFileSync(new URL("../../coach/coach.css", import.meta.url), "utf8"),
);

const SHARED_CONTROLS = [
  ".btn",
  ".icon-btn",
  ".sheet",
  ".scrim",
  ".sheet-layer",
];
const BARE_ELEMENTS = [
  "a",
  "button",
  "input",
  "p",
  "h2",
  "section",
  "body",
  "*",
];

describe("coach.css restyles only the tutorial card", () => {
  it("anchors every rule on the card's own scope", () => {
    const stray = coachRules.flatMap((rule) =>
      rule.selectors.filter((selector) => !anchor(selector).includes(".coach")),
    );
    expect(stray).toEqual([]);
  });

  it("never anchors a rule on a shared control or a bare element", () => {
    const anchors = coachRules.flatMap((rule) =>
      rule.selectors.map((selector) => anchor(selector)),
    );
    for (const found of anchors) {
      expect(SHARED_CONTROLS).not.toContain(found);
      expect(BARE_ELEMENTS).not.toContain(found);
    }
  });

  it("draws above the sheets and the launcher, and below nothing", () => {
    const layer = ruleFor(coachRules, ".coach");
    const z = Number(declarations(layer, "z-index")[0]);
    expect(z).toBeGreaterThan(70);
  });
});

describe("coach.css and reduced motion", () => {
  it("lets the tutorial card glide, and stops every glide under reduced motion", () => {
    // The aperture and the card move between steps — that is the one authored
    // motion — so coach.css is the one place a transition may move something,
    // and only if each such selector is silenced when the person asked.
    const gliding = coachRules
      .filter((rule) => !reduced(rule))
      .filter((rule) =>
        declarations(rule, "transition").some((value) =>
          /\b(top|left|width|height|transform)\b/.test(value),
        ),
      )
      .flatMap((rule) => rule.selectors);
    expect(gliding.length).toBeGreaterThan(0);
    const silenced = new Set(
      coachRules
        .filter(reduced)
        .filter((rule) =>
          declarations(rule, "transition").some((value) => value === "none"),
        )
        .flatMap((rule) => rule.selectors),
    );
    for (const selector of gliding) {
      expect({ selector, silenced: silenced.has(selector) }).toEqual({
        selector,
        silenced: true,
      });
    }
  });

  it("neutralises every animation it starts", () => {
    const silenced = new Set(
      coachRules
        .filter(reduced)
        .filter((rule) =>
          declarations(rule, "animation").some((value) => value === "none"),
        )
        .flatMap((rule) => rule.selectors),
    );
    const animated = coachRules
      .filter((rule) => !reduced(rule))
      .filter((rule) =>
        declarations(rule, "animation").some((value) => value !== "none"),
      )
      .flatMap((rule) => rule.selectors);
    expect(animated.length).toBeGreaterThan(0);
    for (const selector of animated) {
      expect({ selector, silenced: silenced.has(selector) }).toEqual({
        selector,
        silenced: true,
      });
    }
  });
});
