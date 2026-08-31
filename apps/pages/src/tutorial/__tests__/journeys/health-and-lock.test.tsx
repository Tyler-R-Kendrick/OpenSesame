/** @vitest-environment jsdom */

/**
 * Two questions with a checked-in answer, asked of a model.
 *
 * "Is this thing healthy?" has two honest answers in this app, and the
 * authored walkthrough gives both — the statusline for the planes, Vault
 * health for the items. "Where do I lock?" has one, and the interesting part
 * is what the walkthrough does *not* do with it: a guide points, and a person
 * decides. Nothing in this system may press a control on somebody's behalf,
 * least of all the one that drops their keys.
 */

import { fakeAgentAnswering } from "@opensesame/support-agent";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { guideGoal } from "../../registry/goals.js";
import { resolveGuideTargetElement } from "../../registry/targets.js";
import {
  askSupport,
  countClicks,
  openSupport,
  renderJourney,
  reopenSupport,
  resetJourney,
} from "./harness.jsx";

/** The authored program, compiled by the same pipeline model output goes through. */
function authored(id: string): string {
  const goal = guideGoal(id);
  if (!goal) throw new Error(`no authored goal ${id}`);
  return goal.guide;
}

describe("asking whether OpenSesame is healthy", () => {
  afterEach(resetJourney);

  it("shows the planes on the statusline, then walks to the report on the items", async () => {
    const journey = renderJourney(
      fakeAgentAnswering(
        "Two different questions, and this walks you through both.",
        authored("host.health.check"),
      ),
    );
    const { user } = journey;

    await openSupport(user);
    await askSupport(user, "How do I check whether OpenSesame is healthy?");

    // First half of the answer: plane reachability, on the one strip that is
    // on screen at every width.
    await waitFor(() =>
      expect(journey.focused()).toEqual(["shell.connectivity"]),
    );
    expect(journey.drawn()[0]).toMatchObject({
      kind: "focus",
      target: "shell.connectivity",
      side: "top",
    });
    expect(
      resolveGuideTargetElement("shell.connectivity")?.closest(".statusline"),
    ).not.toBeNull();

    // Second half: the walkthrough takes the person to the report itself.
    await waitFor(() =>
      expect(journey.navigations()).toEqual(["/vault/health"]),
    );
    expect(
      await screen.findByRole("heading", { name: "Password health" }),
    ).toBeTruthy();

    await waitFor(() => expect(journey.outcomes()).toHaveLength(1));
    expect(journey.outcomes()[0]).toEqual({
      kind: "completed",
      goal: "host.health.check",
    });
    // It ended, so it took its overlay with it.
    expect(journey.drawn().map((call) => call.kind)).toEqual([
      "focus",
      "clear",
    ]);

    await openSupport(user);
    expect(await screen.findByText("This is Vault health.")).toBeTruthy();
  });
});

describe("asking where the lock is", () => {
  afterEach(resetJourney);

  it("highlights the lock and leaves it alone", async () => {
    const journey = renderJourney(
      fakeAgentAnswering(
        "It sits on the right of the statusline.",
        authored("vault.lock"),
      ),
    );
    const { user } = journey;

    await openSupport(user);
    await askSupport(user, "Where do I lock the vault?");

    await waitFor(() => expect(journey.focused()).toEqual(["shell.lock"]));
    const lock = resolveGuideTargetElement("shell.lock");
    if (!lock) throw new Error("the guide pointed at nothing on screen");
    expect(lock.getAttribute("aria-label")).toBe("Lock vault");
    expect(lock.closest(".statusline")).not.toBeNull();
    const pressesOnTheLock = countClicks(lock);

    // The trajectory is parked on `wait target "shell.lock" event=activate`,
    // and parked is where it stays: nothing synthesised a click, nothing
    // reached the vault store, and the conversation is still here — which it
    // would not be, because locking drops the transcript with the keys.
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Support — walkthrough in progress",
        }),
      ).toBeTruthy(),
    );
    expect(pressesOnTheLock()).toBe(0);
    expect(journey.lockPresses()).toBe(0);
    expect(journey.outcomes()).toEqual([]);
    expect(journey.drawn()).toHaveLength(1);
    expect(journey.engineDestroyed()).toBe(false);

    const panel = await reopenSupport(user);
    expect(
      within(panel).getByText("It sits on the right of the statusline."),
    ).toBeTruthy();
    const status = within(panel).getByRole("region", {
      name: "Walkthrough in progress",
    });
    expect(status.textContent).toContain("Lock the vault");
    expect(within(status).getByRole("button", { name: "Stop" })).toBeTruthy();
    // Reading about the lock did not lock anything either.
    expect(journey.lockPresses()).toBe(0);
  });
});
