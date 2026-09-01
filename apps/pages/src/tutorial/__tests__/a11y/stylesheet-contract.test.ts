/**
 * What the two stylesheets this feature ships are allowed to touch.
 *
 * jsdom has no cascade, so these are assertions about the source rather than
 * about a rendered page — and that is the right level for the two questions
 * asked here. A support panel that restyles `button` or `.btn` would change
 * every control in the vault, and the failure would surface as an unrelated
 * screen looking wrong weeks later. A reduced-motion promise that only holds
 * for some of the rules is the same kind of bug. Both are properties of the
 * text of the file, and both are cheap to keep true.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SUPPORT_CSS = new URL("../../support.css", import.meta.url);
const DRIVER_CSS = new URL("../../rendering/driver.css", import.meta.url);
const APP_CSS = new URL("../../../styles.css", import.meta.url);

type CssRule = {
  readonly selectors: readonly string[];
  readonly body: string;
  /** At-rule preludes enclosing this rule, outermost first. */
  readonly context: readonly string[];
};

function matchingBrace(css: string, from: number): number {
  let depth = 1;
  for (let index = from; index < css.length; index += 1) {
    const character = css[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("unbalanced stylesheet");
}

/**
 * A deliberately small reader: enough for these two hand-written files, and
 * no more. `@keyframes` bodies are skipped outright — their `0%`/`to` steps
 * are not selectors and would only ever be false positives.
 */
function parseRules(source: string): readonly CssRule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  const context: string[] = [];
  let prelude = "";
  let index = 0;
  while (index < css.length) {
    const character = css[index];
    if (character === "{") {
      const head = prelude.trim();
      prelude = "";
      index += 1;
      if (head.startsWith("@keyframes")) {
        index = matchingBrace(css, index) + 1;
      } else if (head.startsWith("@")) {
        context.push(head);
      } else {
        const end = matchingBrace(css, index);
        rules.push({
          selectors: head
            .split(",")
            .map((selector) => selector.trim())
            .filter((selector) => selector.length > 0),
          body: css.slice(index, end),
          context: [...context],
        });
        index = end + 1;
      }
      continue;
    }
    if (character === "}") {
      context.pop();
      index += 1;
      continue;
    }
    prelude += character;
    index += 1;
  }
  return rules;
}

/** The compound a selector starts with — what the rule is anchored on. */
function anchor(selector: string): string {
  const first = selector.split(/[\s>+~]+/)[0];
  return first ?? selector;
}

function reduced(rule: CssRule): boolean {
  return rule.context.some((prelude) =>
    prelude.includes("prefers-reduced-motion: reduce"),
  );
}

function declarations(rule: CssRule, property: string): readonly string[] {
  const found: string[] = [];
  for (const line of rule.body.split(";")) {
    const [name, ...rest] = line.split(":");
    if ((name ?? "").trim() !== property) continue;
    found.push(rest.join(":").trim());
  }
  return found;
}

/** The one rule for a selector, or a failure that names what is missing. */
function ruleFor(
  rules: readonly CssRule[],
  selector: string,
  within?: string,
): CssRule {
  const found = rules.find(
    (rule) =>
      rule.selectors.includes(selector) &&
      (within === undefined ||
        rule.context.some((prelude) => prelude.includes(within))),
  );
  if (!found) throw new Error(`no rule for ${selector}`);
  return found;
}

const supportRules = parseRules(readFileSync(SUPPORT_CSS, "utf8"));
const driverRules = parseRules(readFileSync(DRIVER_CSS, "utf8"));

/** Shared controls the vault defines once, in `styles.css`, and only there. */
const SHARED_CONTROLS = [
  ".btn",
  ".btn--primary",
  ".btn--sm",
  ".btn--ghost",
  ".chip",
  ".go",
  ".go-row",
  ".go-verb",
  ".f__input",
  ".f__shell",
  ".icon-btn",
  ".note",
  ".hint",
  ".actions",
  ".sheet",
  ".scrim",
  ".sheet-layer",
];

const BARE_ELEMENTS = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "progress",
  "output",
  "form",
  "section",
  "article",
  "p",
  "h2",
  "html",
  "body",
  "*",
  ":root",
];

describe("support.css restyles only the support panel", () => {
  it("pins the launcher to the same viewport corner on every screen", () => {
    const rule = ruleFor(supportRules, ".support-launch");
    expect(declarations(rule, "position")).toEqual(["fixed"]);
    expect(declarations(rule, "left")[0]).toMatch(/0\.85rem/);
    expect(declarations(rule, "bottom")[0]).toMatch(/0\.85rem/);
  });

  it("anchors every rule on the panel's own scope", () => {
    const stray = supportRules.flatMap((rule) =>
      rule.selectors.filter(
        (selector) => !anchor(selector).includes(".support"),
      ),
    );
    expect(stray).toEqual([]);
  });

  it("never anchors a rule on a shared control or a bare element", () => {
    const anchors = supportRules.flatMap((rule) =>
      rule.selectors.map((selector) => anchor(selector)),
    );
    for (const found of anchors) {
      expect(SHARED_CONTROLS).not.toContain(found);
      expect(BARE_ELEMENTS).not.toContain(found);
    }
  });

  it("reaches a shared control only from inside the panel", () => {
    // `.support__composer .f__shell` is legitimate — it narrows the shared
    // field wrapper to the one instance the panel owns. What must never
    // appear is that class standing on its own.
    const reaching = supportRules.flatMap((rule) =>
      rule.selectors.filter((selector) =>
        SHARED_CONTROLS.some(
          (control) =>
            selector.includes(`${control} `) || selector.endsWith(control),
        ),
      ),
    );
    for (const selector of reaching) {
      expect(anchor(selector)).toContain(".support");
    }
  });
});

describe("driver.css restyles only the guide overlay", () => {
  it("anchors every rule on the adapter's marker or on a Driver class", () => {
    const stray = driverRules.flatMap((rule) =>
      rule.selectors.filter((selector) => {
        const head = anchor(selector);
        return !head.includes(".os-guide") && !head.includes(".driver-");
      }),
    );
    expect(stray).toEqual([]);
  });

  it("never anchors a rule on a shared control or a bare element", () => {
    const anchors = driverRules.flatMap((rule) =>
      rule.selectors.map((selector) => anchor(selector)),
    );
    for (const found of anchors) {
      expect(SHARED_CONTROLS).not.toContain(found);
      expect(BARE_ELEMENTS).not.toContain(found);
    }
  });
});

describe("reduced motion", () => {
  const files: readonly { name: string; rules: readonly CssRule[] }[] = [
    { name: "support.css", rules: supportRules },
    { name: "driver.css", rules: driverRules },
  ];

  it("neutralises every animation each stylesheet starts", () => {
    for (const file of files) {
      const quiet = file.rules.filter(reduced);
      const silenced = new Set(
        quiet
          .filter((rule) =>
            declarations(rule, "animation").some((value) => value === "none"),
          )
          .flatMap((rule) => rule.selectors),
      );
      const animated = file.rules
        .filter((rule) => !reduced(rule))
        .filter((rule) =>
          declarations(rule, "animation").some((value) => value !== "none"),
        )
        .flatMap((rule) => rule.selectors);

      for (const selector of animated) {
        expect({
          file: file.name,
          selector,
          silenced: silenced.has(selector),
        }).toEqual({ file: file.name, selector, silenced: true });
      }
    }
    // A guard against the whole check going quiet: support.css does start an
    // animation, so this suite has something to have proved.
    expect(
      supportRules
        .filter((rule) => !reduced(rule))
        .flatMap((rule) => declarations(rule, "animation")),
    ).not.toEqual([]);
  });

  it("moves nothing on a transition, so a colour fade is all that is left", () => {
    const MOVING = [
      "transform",
      "translate",
      "top",
      "left",
      "right",
      "bottom",
      "width",
      "height",
      "margin",
      "all",
    ];
    let inspected = 0;
    for (const file of files) {
      for (const rule of file.rules) {
        if (reduced(rule)) continue;
        for (const value of declarations(rule, "transition")) {
          inspected += 1;
          for (const property of MOVING) {
            expect(`${file.name}:${value}`).not.toContain(`${property} `);
          }
        }
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it("leans on the app's own global reset for the sheet it borrows", () => {
    // The panel is a `.sheet`, and `.sheet` slides in from `styles.css` — not
    // from anything this feature owns. That animation is covered by the
    // repository-wide reduced-motion reset, which is why support.css does not
    // (and must not) restate it.
    const appRules = parseRules(readFileSync(APP_CSS, "utf8"));
    const reset = ruleFor(appRules, "*", "prefers-reduced-motion: reduce");
    expect(reset.body).toContain("animation-duration");
    expect(reset.body).toContain("transition-duration");
    expect(reset.body).toContain("!important");
  });

  it("keeps a non-motion cue where the motion carried meaning", () => {
    // The pending caret blinks to say an answer is on its way. Killing the
    // blink outright would leave the state unmarked, so the reduced-motion
    // rule dims it instead of removing it.
    const caret = ruleFor(
      supportRules,
      ".support__pending-read::after",
      "prefers-reduced-motion: reduce",
    );
    expect(declarations(caret, "animation")).toContain("none");
    expect(declarations(caret, "opacity")).toHaveLength(1);
  });
});

describe("the panel reflows rather than clipping", () => {
  it("never lets the sheet grow wider than the viewport", () => {
    const widths = supportRules
      .filter((rule) => rule.selectors.includes(".sheet.support"))
      .flatMap((rule) => declarations(rule, "width"));
    expect(widths.length).toBeGreaterThan(0);
    for (const width of widths) {
      // Either capped against the viewport or handed the whole of it.
      expect(width === "100%" || width.includes("100vw")).toBe(true);
    }
  });

  it("scrolls the body, so the head and the foot cannot be scrolled away", () => {
    // The panel puts its close control in the head and its composer in the
    // foot; both stay put only because the body is the part that scrolls.
    const appRules = parseRules(readFileSync(APP_CSS, "utf8"));
    const body = ruleFor(appRules, ".sheet__body");
    expect(declarations(body, "overflow-y")).toContain("auto");
    expect(declarations(body, "min-height")).toContain("0");
  });

  it("wraps model prose instead of pushing it out of the panel", () => {
    for (const selector of [".support__text", ".support__goal-title"]) {
      // `min-width: 0` is the half people forget: without it a grid or flex
      // child refuses to shrink and one long token wins the argument.
      expect(
        declarations(ruleFor(supportRules, selector), "min-width"),
      ).toContain("0");
    }
    const prose = ruleFor(supportRules, ".support__text");
    expect(declarations(prose, "overflow-wrap")).toContain("anywhere");
    expect(declarations(prose, "white-space")).toContain("pre-wrap");
  });

  it("gives the narrow layout a single column rather than a squeezed one", () => {
    const narrow = supportRules.filter((rule) =>
      rule.context.some((prelude) => prelude.includes("max-width: 900px")),
    );
    const selectors = narrow.flatMap((rule) => rule.selectors);
    expect(selectors).toContain(".sheet.support");
    expect(selectors).toContain(".support__line");
    // The speaker column is dropped at this width, not merely narrowed.
    expect(
      declarations(
        ruleFor(supportRules, ".support__line", "max-width: 900px"),
        "grid-template-columns",
      ),
    ).toEqual(["minmax(0, 1fr)"]);
  });
});
