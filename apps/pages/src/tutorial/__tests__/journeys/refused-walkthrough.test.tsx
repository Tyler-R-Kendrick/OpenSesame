/** @vitest-environment jsdom */

/**
 * A good answer that arrives with a walkthrough the app will not run.
 *
 * `click` is not a directive GuideLang has, and a selector is not a thing the
 * grammar can express, so this program is refused whole — including the two
 * perfectly ordinary lines above the bad one, because parsing is
 * all-or-nothing and a prefix is never executed. What the person gets is the
 * answer they asked for and one sentence saying the walkthrough did not run:
 * not a code, not the offending line, and not silence.
 */

import { SUPPORT_LIMITS, fakeAgentAnswering } from "@opensesame/support-agent";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GUIDE_REFUSED_TEXT } from "../../ui/messages.js";
import {
  askSupport,
  openSupport,
  renderJourney,
  resetJourney,
} from "./harness.jsx";

const ANSWER =
  "Reveal is on the item itself, and it asks you to confirm each time.";

/** Two lines this app would happily run, and one it has no production for. */
const WITH_A_CLICK = [
  "guide/1",
  'goal "vault.lock"',
  'say "Here is where that lives."',
  'focus "shell.lock" "The lock is here." side=top',
  'click "#reveal-secret"',
].join("\n");

describe("a walkthrough the compiler refuses", () => {
  afterEach(resetJourney);

  it("keeps the answer, says the walkthrough did not run, and draws nothing", async () => {
    const agent = fakeAgentAnswering(ANSWER, WITH_A_CLICK);
    const journey = renderJourney(agent);
    const { user } = journey;

    const panel = await openSupport(user);
    await askSupport(user, "How do I see a password?");

    expect(await within(panel).findByText(ANSWER)).toBeTruthy();
    expect(await within(panel).findByText(GUIDE_REFUSED_TEXT)).toBeTruthy();

    const thread = within(panel).getByRole("region", { name: "Conversation" });
    const lines = within(thread).getAllByRole("article");
    // Question, answer, the refusal, and the grounding note every model
    // answer now carries — this one cited nothing, so it is labelled.
    expect(lines).toHaveLength(4);
    expect(lines[1]?.textContent).toContain(ANSWER);
    expect(lines[2]?.textContent).toContain(GUIDE_REFUSED_TEXT);
    expect(lines[3]?.textContent).toContain("written help");

    // Nothing ran: not the `click`, and not the `say` and `focus` above it.
    expect(journey.drawn()).toEqual([]);
    expect(journey.navigations()).toEqual([]);
    expect(journey.outcomes()).toEqual([]);
    // The panel never stepped aside, because there was never a walkthrough to
    // step aside for.
    expect(screen.getByRole("dialog", { name: "Support" })).toBe(panel);
    expect(
      screen.queryByRole("button", {
        name: "Support — walkthrough in progress",
      }),
    ).toBeNull();

    // One bounded repair was spent, and then it stopped asking.
    expect(agent.calls()).toHaveLength(
      1 + SUPPORT_LIMITS.maxGuideRepairAttempts,
    );

    // A refused walkthrough is not an error state: the conversation carries on.
    expect(screen.queryByRole("alert")).toBeNull();
    const composer = await screen.findByLabelText<HTMLInputElement>(
      "Ask about this screen",
    );
    expect(composer.disabled).toBe(false);
  });
});
