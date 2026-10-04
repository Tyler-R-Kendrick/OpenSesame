/** @vitest-environment jsdom */

/**
 * The tutorial, as it behaves once the panel has handed it the page.
 *
 * `coach/placement.test.ts` proves where the card sits, and the runtime suite
 * proves how a tour is paced. What is exercised here is the composition the
 * person actually meets — the sheet closes itself, a tutorial starts on the
 * live page, and the sheet's focus restore and the card's focus move have to
 * agree about who holds the caret if the sequencing is wrong. It is also the
 * one place that asks the questions an assistive technology would: does
 * anything animate when it was asked not to, can the caret leave, can the
 * keyboard get out.
 */

import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TOURING,
  disposeSupport,
  mountSupport,
  openPanel,
  tutorialCard,
  walkthrough,
} from "./harness.js";

/** A `matchMedia` that answers the reduced-motion query and nothing else. */
function stubMotion(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: /prefers-reduced-motion/.test(query) ? reduce : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  disposeSupport();
});

async function startLockTutorial(user: ReturnType<typeof userEvent.setup>) {
  const harness = mountSupport({
    agent: fakeAgentAlwaysUnavailable("no_local_model"),
    transport: "none",
    targets: ["shell.lock"],
  });
  await openPanel(user);
  await user.click(walkthrough("Lock the vault"));
  await tutorialCard();
  return harness;
}

describe("reduced motion, through the panel", () => {
  it("moves nothing between steps when the preference is set", async () => {
    stubMotion(true);
    const user = userEvent.setup();
    await startLockTutorial(user);

    await user.click(screen.getByRole("button", { name: /^Next/ }));
    await waitFor(() =>
      expect(
        document.querySelector(".coach")?.getAttribute("data-coach-step"),
      ).toBe("2"),
    );
    // The aperture does not glide: no transition class is ever put on it.
    expect(document.querySelectorAll(".is-gliding")).toHaveLength(0);
  });

  it("glides the aperture between steps when the preference is not set", async () => {
    stubMotion(false);
    const user = userEvent.setup();
    await startLockTutorial(user);

    await user.click(screen.getByRole("button", { name: /^Next/ }));
    await waitFor(() =>
      expect(document.querySelectorAll(".coach__dim.is-gliding").length).toBe(
        4,
      ),
    );
  });
});

describe("who holds the caret once a tutorial is live", () => {
  it("moves the caret to the card's Next key when a tutorial starts", async () => {
    const user = userEvent.setup();
    await startLockTutorial(user);

    const next = screen.getByRole("button", { name: /^Next/ });
    await waitFor(() => expect(document.activeElement).toBe(next));
    // The sheet's own restore ran first, onto the launcher, and then lost to
    // the card: the person is left on the key that goes on, not behind it.
    expect((await tutorialCard()).contains(document.activeElement)).toBe(true);
  });

  it("does not trap: the caret can leave the card again", async () => {
    const user = userEvent.setup();
    await startLockTutorial(user);
    const card = await tutorialCard();
    await waitFor(() =>
      expect(card.contains(document.activeElement)).toBe(true),
    );

    // Shift-Tab off the first key of the card, onto the page.
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(card.contains(document.activeElement)).toBe(false);
    // Nothing pulls it back a beat later either.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(card.contains(document.activeElement)).toBe(false);
  });

  it("steps with the arrow keys only while the caret is in the card", async () => {
    const user = userEvent.setup();
    const harness = await startLockTutorial(user);
    const counter = () =>
      document.querySelector(".coach__count")?.textContent ?? "";
    expect(counter()).toBe("Step 1 of 2");

    // On the page's own control the arrow is the page's: the tutorial ignores it.
    harness.fixtures.element("shell.lock").focus();
    await user.keyboard("{ArrowRight}");
    expect(counter()).toBe("Step 1 of 2");

    // In the card it is Next, and ArrowLeft is Back.
    screen.getByRole("button", { name: /^Next/ }).focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(counter()).toBe("Step 2 of 2"));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(counter()).toBe("Step 1 of 2"));
  });
});

describe("leaving a tutorial", () => {
  it("leaves on Escape and hands the caret back to where it was", async () => {
    const user = userEvent.setup();
    await startLockTutorial(user);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /^Next/ }),
      ),
    );

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /^Tutorial:/ })).toBeNull(),
    );
    // The mark that says a tutorial was live says plain "Support" again, and
    // it is where the caret went — not dropped on the page.
    const mark = await screen.findByRole("button", { name: "Support" });
    expect(document.activeElement).toBe(mark);
    expect(screen.queryByRole("button", { name: TOURING })).toBeNull();
  });

  it("leaves Escape to a text field, which is its own way out", async () => {
    const user = userEvent.setup();
    await startLockTutorial(user);
    const field = document.createElement("input");
    field.type = "text";
    document.body.appendChild(field);
    field.focus();

    await user.keyboard("{Escape}");
    expect(await tutorialCard()).toBeTruthy();

    field.blur();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /^Tutorial:/ })).toBeNull(),
    );
    field.remove();
  });
});
