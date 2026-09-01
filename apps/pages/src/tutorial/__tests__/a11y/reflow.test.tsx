/** @vitest-environment jsdom */

/**
 * What survives a narrow viewport — and, honestly, what cannot be checked here.
 *
 * jsdom performs no layout: every box is zero by zero, no media query is
 * evaluated, and nothing can overflow. So none of these tests can show that
 * the panel is *legible* at 320 CSS pixels or at 400% zoom; that is what a
 * browser-driven suite is for, and `packages/visual-contract` is where it
 * would go. What is provable here is the structural half, and it is the half
 * that actually breaks: that no control is dropped or hidden at a narrow
 * width, that the panel's commit controls never live in the region that
 * scrolls, and that a single hostile 2,000-character token cannot push the way
 * out of the sheet beyond reach.
 */

import { fakeAgentAnswering } from "@opensesame/support-agent";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  type TestUser,
  disposeSupport,
  mountSupport,
  openPanel,
  reachable,
  tabTo,
} from "./harness.js";

/** One unbroken token, the length a model answer is allowed to reach. */
const HOSTILE_TOKEN = "x".repeat(2000);

async function ask(user: TestUser, question: string): Promise<void> {
  const field = await screen.findByLabelText<HTMLInputElement>(
    "Ask about this screen",
  );
  await waitFor(() => expect(field.disabled).toBe(false));
  await user.type(field, question);
  await user.click(screen.getByRole("button", { name: "Ask" }));
}

function narrowTo(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

afterEach(disposeSupport);

describe("the panel at a narrow viewport", () => {
  it("drops no control when the window narrows to a phone", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Anything.") });
    const sheet = await openPanel(user);

    const before = reachable(sheet);
    narrowTo(320);

    // The responsive behaviour is entirely in the stylesheet, which is the
    // point: there is no width at which a script removes a control, so a
    // phone gets the same panel a desktop does.
    expect(reachable(sheet)).toEqual(before);
    expect(within(sheet).getByLabelText("Ask about this screen")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("keeps the way out and the way in outside the region that scrolls", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Anything.") });
    const sheet = await openPanel(user);

    const scrolling = sheet.querySelector(".sheet__body");
    if (!scrolling) throw new Error("the sheet has no scrolling body");
    const close = within(sheet).getByRole("button", { name: "Close" });
    const compose = within(sheet).getByLabelText("Ask about this screen");
    const send = within(sheet).getByRole("button", { name: "Ask" });

    for (const control of [close, compose, send]) {
      expect(scrolling.contains(control)).toBe(false);
    }
    // The help, which is the long part, is what scrolls.
    expect(
      scrolling.contains(
        within(sheet).getByRole("region", { name: "Written help" }),
      ),
    ).toBe(true);
  });

  it("leaves every control reachable after a 2,000-character unbroken answer", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering(HOSTILE_TOKEN) });
    const sheet = await openPanel(user);
    await ask(user, "say something long");

    const answer = await within(sheet).findByText(HOSTILE_TOKEN);
    // The prose lands in the wrapping element, not in a control, and the sheet
    // gains no scroll region of its own to hide the rest behind.
    expect(answer.className).toContain("support__text");

    await tabTo(user, within(sheet).getByRole("button", { name: "Close" }));
    await tabTo(user, within(sheet).getByLabelText("Ask about this screen"));
    await tabTo(
      user,
      within(sheet).getByRole("button", { name: "Clear conversation" }),
    );
  });
});
