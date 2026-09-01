/** @vitest-environment jsdom */

/**
 * The vault locks in the middle of everything.
 *
 * A support conversation is a record of what somebody could not work out on
 * their own, and it is held in memory for exactly as long as the vault is
 * open. So a lock does not pause this feature, it ends it: the transcript, the
 * model session that saw it, the trajectory in flight and every overlay it
 * drew all go at once — and the answer that was still on its way changes
 * nothing when it finally lands.
 */

import { createFakeSupportAgent } from "@opensesame/support-agent";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  askSupport,
  lockTheVault,
  openSupport,
  renderJourney,
  reopenSupport,
  resetJourney,
} from "./harness.jsx";

const ANSWER = "Connections is where a provider connection is added.";

const POINT_AND_WAIT = [
  "guide/1",
  'goal "connection.create"',
  'focus "nav.connections" "Open Connections to begin." side=right',
  'wait target "nav.connections" event=activate timeout=30000',
].join("\n");

/** Drains macrotasks, so a continuation that lost its race gets its chance. */
async function letTheLateAnswerLand(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("locking while support is busy", () => {
  afterEach(resetJourney);

  it("drops the conversation, the walkthrough and the overlays together", async () => {
    const agent = createFakeSupportAgent({
      sequence: [
        { match: /.*/, answer: ANSWER, guide: POINT_AND_WAIT },
        { match: /.*/, answer: "", abortsMidRun: true },
      ],
    });
    const journey = renderJourney(agent);
    const { user } = journey;

    await openSupport(user);
    await askSupport(user, "How do I add a connection?");
    await waitFor(() => expect(journey.focused()).toEqual(["nav.connections"]));

    // A walkthrough waiting on the person, and a second question still in
    // flight behind it.
    const panel = await reopenSupport(user);
    expect(
      within(panel).getByRole("region", { name: "Walkthrough in progress" }),
    ).toBeTruthy();
    await askSupport(user, "And how do I revoke one afterwards?");
    expect(
      await within(panel).findByRole("button", { name: "Cancel" }),
    ).toBeTruthy();

    lockTheVault();

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull(),
    );
    expect(journey.engineDestroyed()).toBe(true);
    // The provider session that saw the transcript went with it.
    expect(journey.agentDestroyed()).toBe(true);
    // One highlight was ever drawn, and the overlays came down with the keys.
    expect(journey.drawn().filter((call) => call.kind !== "clear")).toEqual([
      {
        kind: "focus",
        target: "nav.connections",
        message: "Open Connections to begin.",
        side: "right",
      },
    ]);
    expect(journey.drawn().some((call) => call.kind === "clear")).toBe(true);
    expect(journey.outcomes().at(-1)).toEqual({
      kind: "cancelled",
      goal: "connection.create",
      reason: "lock",
    });
    expect(journey.targetsCleared()).toBeGreaterThan(0);
    // The statusline stops advertising a walkthrough, because there is none.
    expect(
      screen.queryByRole("button", {
        name: "Support — walkthrough in progress",
      }),
    ).toBeNull();

    const drawnAtLock = journey.drawn().length;
    await letTheLateAnswerLand();

    // The question that was in flight resolves into a session nobody is
    // holding: no answer, no overlay, no error in front of a locked vault.
    expect(journey.drawn()).toHaveLength(drawnAtLock);
    expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    // Opening support again starts from nothing.
    const reopened = await openSupport(user);
    // Nothing to clear, because there is nothing left to clear.
    expect(
      within(reopened).queryByRole("button", { name: "Clear conversation" }),
    ).toBeNull();
    expect(screen.queryByText(ANSWER)).toBeNull();
    expect(screen.queryByText("How do I add a connection?")).toBeNull();
  });
});
