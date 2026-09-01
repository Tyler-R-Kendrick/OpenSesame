/** @vitest-environment jsdom */

/**
 * The walkthrough, as it behaves once the panel has handed it the page.
 *
 * `rendering/driver-renderer.test.ts` already proves the adapter in isolation:
 * reduced motion reaches Driver's config, an annotation is a `note` and takes
 * no caret, a hint gives the caret back. None of that is repeated here. What
 * is exercised instead is the composition the person actually meets — the
 * sheet closes itself, a walkthrough starts on the live page, and the two
 * disagree about who should hold focus if anybody got the sequencing wrong.
 */

import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ANNOTATION_ATTRIBUTE } from "../../rendering/annotation.js";
import {
  disposeSupport,
  launcher,
  mountSupport,
  openPanel,
  walkthrough,
} from "./harness.js";

/**
 * Every annotation the run put on the page, kept after the fact.
 *
 * `end` clears the renderer, so a callout raised by a walkthrough that runs to
 * completion is gone by the time the test can look for it. Watching the
 * document is how its attributes stay observable — and the node's own
 * `remove()` does not rewrite them, so the assertions below are about the
 * annotation as it actually stood on screen.
 */
type AnnotationWatcher = {
  seen(): readonly HTMLElement[];
  stop(): void;
};

function watchAnnotations(): AnnotationWatcher {
  const seen: HTMLElement[] = [];
  const collect = (nodes: NodeList): void => {
    for (const node of nodes) {
      if (
        node instanceof HTMLElement &&
        node.hasAttribute(ANNOTATION_ATTRIBUTE)
      ) {
        seen.push(node);
      }
    }
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) collect(record.addedNodes);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return {
    seen: () => {
      for (const record of observer.takeRecords()) collect(record.addedNodes);
      return [...seen];
    },
    stop: () => observer.disconnect(),
  };
}

afterEach(disposeSupport);

describe("reduced motion, through the panel", () => {
  it("starts a walkthrough with no animation when the preference is set", async () => {
    const user = userEvent.setup();
    const harness = mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
      targets: ["shell.lock"],
      reducedMotion: true,
    });
    await openPanel(user);
    await user.click(walkthrough("Lock the vault"));

    await waitFor(() => expect(harness.driver.records()).toHaveLength(1));
    const config = harness.driver.records()[0]?.config;
    expect(config?.animate).toBe(false);
    expect(config?.smoothScroll).toBe(false);
  });

  it("animates the same walkthrough when the preference is not set", async () => {
    const user = userEvent.setup();
    const harness = mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
      targets: ["shell.lock"],
      reducedMotion: false,
    });
    await openPanel(user);
    await user.click(walkthrough("Lock the vault"));

    await waitFor(() => expect(harness.driver.records()).toHaveLength(1));
    expect(harness.driver.records()[0]?.config.animate).toBe(true);
  });

  it("carries the preference into a hint beacon as well as the spotlight", async () => {
    const user = userEvent.setup();
    const harness = mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
      route: "/vault/health",
      targets: ["vault.health.summary", "vault.health.findings"],
      reducedMotion: true,
    });
    await openPanel(user);
    await user.click(walkthrough("Review password health"));

    await waitFor(() => expect(harness.hints.records()).toHaveLength(1));
    const spec = harness.hints.records()[0]?.config.hints[0];
    expect(spec?.beacon.animate).toBe(false);
    // A beacon is an aside, so it never draws its own scrim either.
    expect(harness.hints.records()[0]?.config.overlay).toBe(false);
  });
});

describe("who holds the caret once a walkthrough is live", () => {
  it("hands the caret to the highlighted control rather than to the overlay", async () => {
    const user = userEvent.setup();
    const harness = mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
      targets: ["shell.lock"],
    });
    await openPanel(user);
    await user.click(walkthrough("Lock the vault"));

    const lock = harness.fixtures.element("shell.lock");
    await waitFor(() => expect(document.activeElement).toBe(lock));
    // The popover is on the page and is a dialog, but it is not where the
    // person was left: acting on the guidance is one keypress, not a tab out.
    const popovers = harness.driver.popovers();
    expect(popovers).toHaveLength(1);
    for (const popover of popovers) {
      expect(popover.contains(document.activeElement)).toBe(false);
    }
  });

  it("does not trap: the caret can leave the highlighted control again", async () => {
    const user = userEvent.setup();
    const harness = mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
      targets: ["shell.lock"],
    });
    await openPanel(user);
    await user.click(walkthrough("Lock the vault"));

    const lock = harness.fixtures.element("shell.lock");
    await waitFor(() => expect(document.activeElement).toBe(lock));

    await user.tab();
    expect(document.activeElement).not.toBe(lock);
    // Nothing pulls it back a beat later either.
    await waitFor(() => expect(document.activeElement).not.toBe(lock));
  });

  it("annotates and hints through a whole walkthrough without taking the caret", async () => {
    const user = userEvent.setup();
    mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
      route: "/vault/health",
      targets: ["vault.health.summary", "vault.health.findings"],
    });
    await openPanel(user);
    const watcher = watchAnnotations();
    try {
      await user.click(walkthrough("Review password health"));

      // The sheet steps aside, the walkthrough runs to its `end`, and the
      // statusline goes back to saying plain "Support".
      await waitFor(() => expect(watcher.seen()).toHaveLength(1));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Support" })).toBeTruthy(),
      );

      const note = watcher.seen()[0];
      if (!note) throw new Error("the walkthrough annotated nothing");
      expect(note.getAttribute("role")).toBe("note");
      expect(note.hasAttribute("aria-modal")).toBe(false);
      expect(note.hasAttribute("tabindex")).toBe(false);
      expect(
        note.querySelectorAll("a, button, input, select, textarea, [tabindex]"),
      ).toHaveLength(0);
      expect(note.textContent).toContain("The verdict");

      // Nothing of the walkthrough is left on the page, and the caret is
      // still on the control the person last used — not on a beacon, not on a
      // popover, and not on a callout nobody can dismiss.
      expect(
        document.querySelectorAll(`[${ANNOTATION_ATTRIBUTE}]`),
      ).toHaveLength(0);
      expect(document.querySelectorAll(".driver-popover")).toHaveLength(0);
      expect(document.activeElement).toBe(launcher());

      // And the panel still opens onto its own controls afterwards.
      await user.click(launcher());
      const sheet = await screen.findByRole("dialog", { name: "Support" });
      expect(
        within(sheet).getByRole("region", { name: "Written help" }),
      ).toBeTruthy();
    } finally {
      watcher.stop();
    }
  });
});
