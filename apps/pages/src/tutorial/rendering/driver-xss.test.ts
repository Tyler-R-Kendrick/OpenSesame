/** @vitest-environment jsdom */

/**
 * The text-only mechanism, proved against the real Driver.js rather than a
 * stand-in. Driver 1.8 fills `.driver-popover-description` with `innerHTML`,
 * so a fake that merely recorded the string would prove nothing about the
 * library actually shipped.
 */

import type { GuideTargetId } from "@opensesame/guide-lang";
import type { GuideRenderer } from "@opensesame/guide-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANNOTATION_ATTRIBUTE } from "./annotation.js";
import { createDriverRenderer, loadDriverRenderer } from "./driver-renderer.js";

const TARGET: GuideTargetId = "nav.connections";

const PAYLOADS = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  '<a href="javascript:alert(1)">x</a>',
  "<svg onload=alert(1)>",
] as const;

/** Driver paints its scrim on the next animation frame, not during highlight. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

let element: HTMLButtonElement;
let renderer: GuideRenderer;

beforeEach(() => {
  document.body.replaceChildren();
  element = document.createElement("button");
  element.type = "button";
  element.textContent = "Connections";
  document.body.appendChild(element);
  renderer = createDriverRenderer({
    resolveElement: () => element,
    // Driver renders its popover synchronously when it is not animating.
    reducedMotion: () => true,
  });
});

afterEach(() => {
  renderer.clear();
});

describe("driver.js popovers, against the real library", () => {
  for (const payload of PAYLOADS) {
    it(`renders ${payload} as literal text in a focus popover`, async () => {
      await renderer.focus({ target: TARGET, message: payload, side: "right" });

      const popover = document.querySelector(".driver-popover");
      const description = popover?.querySelector(".driver-popover-description");
      expect(popover).not.toBeNull();
      expect(description).not.toBeNull();
      expect(description?.textContent).toBe(payload);
      expect(description?.childNodes).toHaveLength(1);
      expect(description?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(description?.querySelector("img, script, svg, a")).toBeNull();
      expect(popover?.querySelector("img, script, svg, a")).toBeNull();
      expect(document.querySelector("body img, body script")).toBeNull();
    });

    it(`renders ${payload} as literal text in a hint popover`, async () => {
      await renderer.hint({ target: TARGET, message: payload, side: "top" });

      const popover = document.querySelector(".driver-hint-popover");
      const description = popover?.querySelector(".driver-popover-description");
      expect(popover).not.toBeNull();
      expect(description?.textContent).toBe(payload);
      expect(description?.childNodes).toHaveLength(1);
      expect(description?.querySelector("img, script, svg, a")).toBeNull();
      expect(popover?.querySelector("img, script, svg, a")).toBeNull();
    });

    it(`renders ${payload} as literal text in an annotation`, async () => {
      await renderer.annotate({ target: TARGET, message: payload, side: null });

      const annotation = document.querySelector(`[${ANNOTATION_ATTRIBUTE}]`);
      expect(annotation?.textContent).toBe(payload);
      expect(annotation?.querySelector("img, script, svg, a")).toBeNull();
    });
  }

  it("names the popover from authored text, never from the message", async () => {
    await renderer.focus({
      target: TARGET,
      message: "<b>bold</b>",
      side: null,
    });

    const popover = document.querySelector(".driver-popover");
    expect(popover?.getAttribute("aria-label")).toBe("Guide");
    expect(popover?.hasAttribute("aria-labelledby")).toBe(false);
    expect(popover?.querySelector(".driver-popover-title")?.textContent).toBe(
      "",
    );
  });

  it("clears every overlay, popover, beacon and annotation it created", async () => {
    await renderer.focus({ target: TARGET, message: "one", side: null });
    await renderer.hint({ target: TARGET, message: "two", side: null });
    await renderer.annotate({ target: TARGET, message: "three", side: null });
    await nextFrame();
    expect(document.querySelectorAll(".driver-popover")).not.toHaveLength(0);
    expect(document.querySelectorAll(".driver-overlay")).not.toHaveLength(0);
    expect(document.querySelectorAll(".driver-hint")).not.toHaveLength(0);

    renderer.clear();

    expect(document.querySelectorAll(".driver-popover")).toHaveLength(0);
    expect(document.querySelectorAll(".driver-overlay")).toHaveLength(0);
    expect(document.querySelectorAll(".driver-hint")).toHaveLength(0);
    expect(document.querySelectorAll(".driver-active-element")).toHaveLength(0);
    expect(document.querySelectorAll(`[${ANNOTATION_ATTRIBUTE}]`)).toHaveLength(
      0,
    );
    expect(document.body.classList.contains("driver-active")).toBe(false);
    expect(document.body.children).toHaveLength(1);
  });

  it("keeps the page keyboard-operable and dismissible with Escape", async () => {
    await renderer.focus({ target: TARGET, message: "Open it.", side: null });

    expect(document.activeElement).toBe(element);
    const popover = document.querySelector(".driver-popover");
    expect(popover?.querySelector(".driver-popover-close-btn")).not.toBeNull();

    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Escape", bubbles: true }),
    );

    expect(document.querySelectorAll(".driver-popover")).toHaveLength(0);
  });

  it("dismisses on a click against the scrim, so nobody is stuck behind it", async () => {
    await renderer.focus({ target: TARGET, message: "Open it.", side: null });

    await nextFrame();

    const scrim = document.querySelector(".driver-overlay");
    const cutout = scrim?.firstElementChild;
    expect(cutout?.tagName).toBe("path");
    cutout?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(document.querySelectorAll(".driver-popover")).toHaveLength(0);
    expect(document.querySelectorAll(".driver-overlay")).toHaveLength(0);
    expect(document.body.classList.contains("driver-active")).toBe(false);
  });

  it("leaves hints and annotations outside the modal spotlight", async () => {
    await renderer.hint({ target: TARGET, message: "aside", side: null });
    await renderer.annotate({ target: TARGET, message: "callout", side: null });

    expect(document.body.classList.contains("driver-active")).toBe(false);
    const annotation = document.querySelector(`[${ANNOTATION_ATTRIBUTE}]`);
    expect(annotation?.getAttribute("role")).toBe("note");
    expect(annotation?.hasAttribute("aria-modal")).toBe(false);
    expect(document.querySelectorAll("[aria-modal]")).toHaveLength(0);
  });

  it("loads the library and its stylesheets on demand", async () => {
    const lazy = await loadDriverRenderer({
      resolveElement: () => element,
      reducedMotion: () => true,
    });
    await lazy.focus({ target: TARGET, message: "<i>lazy</i>", side: null });

    const description = document.querySelector(".driver-popover-description");
    expect(description?.textContent).toBe("<i>lazy</i>");
    lazy.clear();
    expect(document.querySelectorAll(".driver-popover")).toHaveLength(0);
  });
});
