/** @vitest-environment jsdom */

/**
 * The tutorial card, driven through the real panel.
 *
 * `placement.test.ts` proves where it sits and the runtime suite proves how a
 * tour is paced. This proves what is on the card at each step: Back and Next
 * (Replay and Done on the closing card), the "your move" cue, the segmented
 * meter, and what happens to a step whose control is not on screen.
 */

import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  disposeSupport,
  mountSupport,
  openPanel,
  tutorialCard,
  walkthrough,
} from "../__tests__/a11y/harness.js";

afterEach(disposeSupport);

async function startLock(targets: readonly string[] = ["shell.lock"]) {
  const user = userEvent.setup();
  const harness = mountSupport({
    agent: fakeAgentAlwaysUnavailable("no_local_model"),
    transport: "none",
    // SAFETY: fixture constructed in this test matches the declared contract.
    targets: [...targets] as never,
  });
  // jsdom has no layout: give the control a box, or there is nothing to light.
  for (const id of targets) {
    // SAFETY: fixture constructed in this test matches the declared contract.
    harness.fixtures.element(id as never).getBoundingClientRect = () =>
      ({
        left: 20,
        top: 20,
        right: 52,
        bottom: 52,
        width: 32,
        height: 32,
        x: 20,
        y: 20,
        toJSON() {},
      }) as DOMRect;
  }
  await openPanel(user);
  await user.click(walkthrough("Lock the vault"));
  return { user, harness, card: await tutorialCard() };
}

const counter = (card: HTMLElement) =>
  card.querySelector(".coach__count")?.textContent ?? "";

describe("the tutorial card", () => {
  it("has Next on every step and Done on the closing card", async () => {
    const { user, card } = await startLock();
    expect(counter(card)).toBe("Step 1 of 2");
    expect(within(card).getByRole("button", { name: /^Next/ })).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() => expect(counter(card)).toBe("Step 2 of 2"));
    expect(within(card).getByRole("button", { name: /^Next/ })).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() => expect(counter(card)).toBe("Complete"));
    expect(within(card).getByRole("button", { name: /^Done/ })).toBeTruthy();
    expect(within(card).getByRole("button", { name: /^Replay/ })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /^Next/ })).toBeNull();
  });

  it("goes Back, and Back is not offered on the first step", async () => {
    const { user, card } = await startLock();
    const back = () =>
      within(card).getByRole<HTMLButtonElement>("button", { name: /^Back/ });
    expect(back().disabled).toBe(true);

    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() => expect(counter(card)).toBe("Step 2 of 2"));
    expect(back().disabled).toBe(false);
    await user.click(back());
    await waitFor(() => expect(counter(card)).toBe("Step 1 of 2"));
  });

  it("replays from the closing card and finishes with Done", async () => {
    const { user, card } = await startLock();
    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await user.click(await screen.findByRole("button", { name: /^Next/ }));
    await waitFor(() => expect(counter(card)).toBe("Complete"));

    await user.click(within(card).getByRole("button", { name: /^Replay/ }));
    await waitFor(() => expect(counter(card)).toBe("Step 1 of 2"));

    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await user.click(await screen.findByRole("button", { name: /^Next/ }));
    await user.click(await screen.findByRole("button", { name: /^Done/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /^Tutorial:/ })).toBeNull(),
    );
  });

  it("fills one meter segment per step, the current one marked", async () => {
    const { user, card } = await startLock();
    const segments = () =>
      [...card.querySelectorAll(".coach__seg")].map((node) =>
        node.className.replace("coach__seg coach__seg--", ""),
      );
    expect(segments()).toEqual(["now", "ahead"]);
    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() => expect(segments()).toEqual(["done", "now"]));
  });

  it("says it is the person's move on a step that waits for them", async () => {
    const { user, card } = await startLock();
    expect(card.querySelector(".coach__cue")?.textContent).toBe("");
    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() =>
      expect(card.querySelector(".coach__cue")?.textContent).toContain(
        "your move",
      ),
    );
  });

  it("says so, and still has Next, when the control it points at is not on screen", async () => {
    // No fixture is bound for the lock, so the step has nothing to light.
    const { user, card } = await startLock([]);
    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() =>
      expect(card.querySelector(".coach__cue")?.textContent).toContain(
        "not on screen",
      ),
    );
    expect(document.querySelector(".coach__ring")).toBeNull();
    expect(within(card).getByRole("button", { name: /^Next/ })).toBeTruthy();
  });

  it("writes the sentence as text, whatever it contains", async () => {
    const { card } = await startLock();
    // The first step is authored prose and arrives as one text node.
    const text = card.querySelector(".coach__text");
    expect(text?.querySelectorAll("*").length).toBe(1); // only the hidden counter
    expect(text?.textContent).toContain("Locking drops the keys");
  });
});
