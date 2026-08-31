/** @vitest-environment jsdom */

/**
 * Markup from a model, all the way to the glass.
 *
 * `driver-xss.test.ts` hands payloads straight to the renderer, which proves
 * the adapter. It does not prove the chain: a raw completion has to survive
 * `parseSupportTurn`'s fence handling, the compiler's string literals, the
 * runtime's own message checks and the port hop before it reaches a popover,
 * and every one of those touches the string. This drives the whole path with
 * the real Driver.js library and asserts on the document at the end of it.
 */

import { parseSupportTurn } from "@opensesame/support-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DomEngine,
  createDeferredSupportAgent,
  createDomEngine,
  liveOverlayCount,
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

function build(): DomEngine {
  const built = createDomEngine(createDeferredSupportAgent());
  engine = built;
  return built;
}

afterEach(() => {
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

async function run(active: DomEngine, directive: string): Promise<void> {
  const turn = parseSupportTurn(completion(directive));
  expect(turn.guide).not.toBeNull();
  const program = active.compile(turn.guide ?? "");
  if (program === null) throw new Error(`did not compile: ${directive}`);
  void active.runGuide(program);
  await waitUntil(() => liveOverlayCount() > 0);
}

function popoverText(): string {
  const description = document.querySelector(".driver-popover-description");
  return description?.textContent ?? "";
}

function expectInert(scope: ParentNode): void {
  expect(
    scope.querySelectorAll("img, script, svg, iframe, style, a").length,
  ).toBe(0);
}

describe("model markup, driven from a raw completion to the document", () => {
  for (const payload of PAYLOADS) {
    it(`stays literal text in a focus popover: ${payload}`, async () => {
      const active = build();
      await run(active, `focus "shell.lock" ${JSON.stringify(payload)}`);

      const popover = document.querySelector(".driver-popover");
      expect(popover).not.toBeNull();
      expect(popoverText()).toBe(payload);
      if (popover) expectInert(popover);
      expect(document.images).toHaveLength(0);
      expect(document.scripts).toHaveLength(0);
      expect(document.querySelectorAll("iframe")).toHaveLength(0);
    });

    it(`stays literal text in an annotation: ${payload}`, async () => {
      const active = build();
      await run(active, `annotate "shell.lock" ${JSON.stringify(payload)}`);

      const annotation = document.querySelector("[data-os-guide-annotation]");
      expect(annotation).not.toBeNull();
      expect(annotation?.textContent).toBe(payload);
      if (annotation) expectInert(annotation);
      expect(document.images).toHaveLength(0);
      expect(document.scripts).toHaveLength(0);
    });
  }

  it("stays literal text in a hint popover", async () => {
    const active = build();
    const payload = PAYLOADS[0] ?? "";
    await run(active, `hint "shell.lock" ${JSON.stringify(payload)}`);

    expect(popoverText()).toBe(payload);
    expect(document.images).toHaveLength(0);
  });
});

describe("the popover a walkthrough draws", () => {
  it("is named by us, never by the message", async () => {
    const active = build();
    await run(active, 'focus "shell.lock" "<h1>Guide by evil</h1>"');

    const popover = document.querySelector(".driver-popover");
    expect(popover?.getAttribute("aria-label")).toBe("Guide");
    expect(popover?.hasAttribute("aria-labelledby")).toBe(false);
    expect(popover?.querySelector("h1")).toBeNull();
  });

  it("carries no text from the control it is pointing at", async () => {
    const active = build();
    active.targets.element("shell.lock").textContent = CONTROL_LABEL;

    await run(active, 'focus "shell.lock" "Press this to lock the vault."');

    const popover = document.querySelector(".driver-popover");
    expect(popover?.textContent).not.toContain(CONTROL_LABEL);
    expect(popoverText()).toBe("Press this to lock the vault.");
    // The label really is on the page, so the assertion above is not vacuous.
    expect(document.body.textContent).toContain(CONTROL_LABEL);
  });
});
