/** @vitest-environment jsdom */

/**
 * Markup from a model, all the way to the glass.
 *
 * A raw completion has to survive `parseSupportTurn`'s fence handling, the
 * compiler's string literals, the runtime's own message checks and the
 * controller before it reaches the tutorial card, and every one of those
 * touches the string. This drives the whole path with the real card and
 * asserts on the document at the end of it: the words arrive as text, and
 * nothing a model wrote becomes an element.
 */

import { parseSupportTurn } from "@opensesame/support-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DomEngine,
  createDeferredSupportAgent,
  createDomEngine,
  liveOverlayCount,
  mountTour,
  waitUntil,
} from "./harness.js";

const PAYLOADS: readonly string[] = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  '<a href="javascript:alert(1)">click me</a>',
  "<svg onload=alert(1)>",
  "<iframe src=javascript:alert(1)></iframe>",
  "</div><style>body{display:none}</style>",
];

/** A label on the control being pointed at — user-authored text, on screen. */
const CONTROL_LABEL = "ELEMENT-LABEL-SENTINEL";

let engine: DomEngine | null = null;
let tour: ReturnType<typeof mountTour> | null = null;

function build(): DomEngine {
  const built = createDomEngine(createDeferredSupportAgent());
  engine = built;
  tour = mountTour(built);
  return built;
}

afterEach(() => {
  tour?.unmount();
  tour = null;
  engine?.destroy();
  engine?.targets.unmountAll();
  engine = null;
  document.body.replaceChildren();
});

/** The completion a model would actually produce: prose, then a fence. */
function completion(directive: string): string {
  return [
    "Here is where that lives.",
    "",
    "```guide",
    "guide/1",
    'goal "vault.lock"',
    directive,
    "pause",
    "```",
  ].join("\n");
}

async function run(_active: DomEngine, directive: string): Promise<void> {
  const turn = parseSupportTurn(completion(directive));
  expect(turn.guide).not.toBeNull();
  void tour?.controller.startGuide(turn.guide ?? "", "model");
  await waitUntil(() => liveOverlayCount() > 0);
}

/** The step's sentence as a person reads it, without the screen-reader prefix. */
function stepText(): string {
  return (
    document
      .querySelector(".coach__text")
      ?.textContent?.replace(/^Step \d+ of \d+\. /, "") ?? ""
  );
}

function expectInert(scope: ParentNode): void {
  expect(
    scope.querySelectorAll(
      "img, script, svg:not([aria-hidden]), iframe, style, a",
    ).length,
  ).toBe(0);
}

describe("model markup, driven from a raw completion to the document", () => {
  for (const directive of ["focus", "annotate", "hint"] as const) {
    for (const payload of PAYLOADS) {
      it(`stays literal text in a ${directive} step: ${payload}`, async () => {
        const active = build();
        await run(
          active,
          `${directive} "shell.lock" ${JSON.stringify(payload)}`,
        );

        const card = document.querySelector(".coach__card");
        expect(card).not.toBeNull();
        expect(stepText()).toBe(payload);
        if (card) expectInert(card);
        expect(document.images).toHaveLength(0);
        expect(document.scripts).toHaveLength(0);
        expect(document.querySelectorAll("iframe")).toHaveLength(0);
      });
    }
  }
});

describe("the card a tutorial draws", () => {
  it("is named by us, never by the message", async () => {
    const active = build();
    await run(active, 'focus "shell.lock" "<h1>Guide by evil</h1>"');

    const card = document.querySelector(".coach__card");
    const titleId = card?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(titleId)?.textContent).toBe(
      "Tutorial: Lock the vault",
    );
    expect(card?.querySelector("h1")).toBeNull();
  });

  it("carries no text from the control it is pointing at", async () => {
    const active = build();
    active.targets.element("shell.lock").textContent = CONTROL_LABEL;

    await run(active, 'focus "shell.lock" "Press this to lock the vault."');

    const card = document.querySelector(".coach__card");
    expect(card?.textContent).not.toContain(CONTROL_LABEL);
    expect(stepText()).toBe("Press this to lock the vault.");
    // The label really is on the page, so the assertion above is not vacuous.
    expect(document.body.textContent).toContain(CONTROL_LABEL);
  });
});
