/** @vitest-environment jsdom */

/**
 * Adding a provider connection — the journey the whole feature exists for.
 *
 * A walkthrough here is not a script that plays to the end. It is one short
 * trajectory that says the next true thing and then stops at an observation
 * boundary, and a model that plans the next one from where the person actually
 * got to. Both stories below are that loop; they differ only in how the person
 * chose to arrive, which is exactly the thing the runtime is supposed not to
 * care about.
 */

import { GUIDE_RUNTIME_NOTES } from "@opensesame/guide-runtime";
import { fakeAgentReplanning } from "@opensesame/support-agent";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGuideTargetElement } from "../../registry/targets.js";
import {
  askSupport,
  countClicks,
  openSupport,
  renderJourney,
  resetJourney,
} from "./harness.jsx";

/** Ends at the boundary: the person has to open Connections themselves. */
const POINT_AT_CONNECTIONS = [
  "guide/1",
  'goal "connection.create"',
  'say "A provider connection is approved once, over in Connections."',
  'focus "nav.connections" "Open Connections to begin." side=right',
  'wait target "nav.connections" event=activate timeout=30000',
].join("\n");

/** Only nameable once the person is on Connections. */
const POINT_AT_THE_CATALOG = [
  "guide/1",
  'goal "connection.create"',
  'focus "connections.provider-picker" "Find the provider here — a name or a connector id both match." side=bottom',
  'wait target "connections.authorize" event=appear timeout=60000',
].join("\n");

const ARRIVE_BY_ROUTE = [
  "guide/1",
  'goal "connection.create"',
  'focus "nav.connections" "Connections is the next stop. Open it however you like." side=right',
  'wait route "/connections" timeout=15000',
  'success "This is Connections. Adding one starts from the catalog."',
  "end",
].join("\n");

describe("adding a connection, one observation at a time", () => {
  afterEach(resetJourney);

  it("points at Connections, waits for the person, then replans from where they arrived", async () => {
    const agent = fakeAgentReplanning([
      {
        answer: "Connections is where a provider connection is added.",
        guide: POINT_AT_CONNECTIONS,
      },
      {
        answer: "You are on Connections now. The catalog is where to start.",
        guide: POINT_AT_THE_CATALOG,
      },
    ]);
    const journey = renderJourney(agent);
    const { user } = journey;

    await openSupport(user);
    await askSupport(user, "How do I add a connection?");

    await waitFor(() => expect(journey.focused()).toEqual(["nav.connections"]));

    // What it pointed at is the rail entry, resolved through the registry — the
    // model named `nav.connections` and never saw an element or a selector.
    const railEntry = resolveGuideTargetElement("nav.connections");
    if (!railEntry) throw new Error("the guide pointed at nothing on screen");
    expect(railEntry.className).toContain("railtree__row");
    // It pointed. It did not move anybody: `navigate` was never asked for.
    expect(journey.navigations()).toEqual([]);

    await user.click(railEntry);

    // The trajectory ends where the model planned it to end — at the wait it
    // could not see past — rather than by running out of instructions.
    await waitFor(() => expect(journey.outcomes()).toHaveLength(1));
    expect(journey.outcomes()[0]).toMatchObject({
      kind: "observed",
      goal: "connection.create",
      note: GUIDE_RUNTIME_NOTES.waitSatisfied,
    });

    // The panel stepped aside while the walkthrough was live. The answer it
    // came with is still in the transcript when the person comes back.
    await openSupport(user);
    expect(
      await screen.findByText(
        "Connections is where a provider connection is added.",
      ),
    ).toBeTruthy();

    await askSupport(user, "I am on Connections now. What next?");

    // The replan is planned against the page the person reached, not the one
    // they asked from: same conversation, new context, new vocabulary.
    const asked = agent.calls();
    expect(asked).toHaveLength(2);
    const opening = asked[0];
    const replan = asked[1];
    expect(opening?.context.route).toBe("/vault");
    // The first turn could not have named the catalog even if it had wanted
    // to: that control was not in the vocabulary it was given.
    expect(
      opening?.context.targets.some(
        (target) => target.id === "connections.provider-picker",
      ),
    ).toBe(false);
    expect(replan?.context.route).toBe("/connections");
    expect(
      replan?.context.targets.find(
        (target) => target.id === "connections.provider-picker",
      ),
    ).toMatchObject({ mounted: true });
    expect(replan?.history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);

    await waitFor(() =>
      expect(journey.focused()).toEqual([
        "nav.connections",
        "connections.provider-picker",
      ]),
    );
    // The second trajectory names a control that did not exist in the
    // vocabulary the first one was compiled against.
    expect(resolveGuideTargetElement("connections.provider-picker")).toBe(
      screen.getByLabelText("Search connectors"),
    );
    // Still nothing navigated, and the second trajectory is parked on its own
    // boundary — the Authorization panel appearing.
    expect(journey.navigations()).toEqual([]);
    expect(journey.outcomes()).toHaveLength(1);
    expect(
      await screen.findByRole("button", {
        name: "Support — walkthrough in progress",
      }),
    ).toBeTruthy();
  });

  it("advances when the person arrives their own way, not when they take the highlight", async () => {
    const journey = renderJourney(
      fakeAgentReplanning([
        {
          answer: "Connections lists every provider this Host holds.",
          guide: ARRIVE_BY_ROUTE,
        },
      ]),
    );
    const { user } = journey;

    await openSupport(user);
    await askSupport(user, "Where do connections live?");
    await waitFor(() => expect(journey.focused()).toEqual(["nav.connections"]));

    const railEntry = resolveGuideTargetElement("nav.connections");
    if (!railEntry) throw new Error("the guide pointed at nothing on screen");
    const clicksOnTheHighlight = countClicks(railEntry);

    // The keyboard jump the shell has always had: `g` then `c`. The guide is
    // waiting on arrival, and this is an arrival.
    await user.keyboard("gc");

    await waitFor(() => expect(journey.outcomes()).toHaveLength(1));
    expect(journey.outcomes()[0]).toEqual({
      kind: "completed",
      goal: "connection.create",
    });
    // Semantic progress: the control it highlighted was never touched, and the
    // guide never navigated on the person's behalf either.
    expect(clicksOnTheHighlight()).toBe(0);
    expect(journey.navigations()).toEqual([]);
    // `end` takes the overlay down with it.
    expect(journey.drawn().map((call) => call.kind)).toEqual([
      "focus",
      "clear",
    ]);

    await openSupport(user);
    expect(
      await screen.findByText(
        "This is Connections. Adding one starts from the catalog.",
      ),
    ).toBeTruthy();
  });
});
