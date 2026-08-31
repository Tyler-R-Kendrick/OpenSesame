/** @vitest-environment jsdom */

/**
 * The same walkthrough, on a phone.
 *
 * This app renders each section twice — a rail row on a desktop, a tab-bar
 * link under `@media (max-width: 900px)` — and exactly one of them is on
 * screen at any width. So `nav.connections` binds both, and resolution picks
 * whichever can actually be pointed at. Nothing external styles a jsdom
 * document, so the rail is hidden here the way the media query hides it:
 * `display: none`.
 */

import { fakeAgentAnswering } from "@opensesame/support-agent";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  duplicateGuideTargetMounts,
  resolveGuideTargetElement,
} from "../../registry/targets.js";
import {
  askSupport,
  openSupport,
  renderJourney,
  resetJourney,
} from "./harness.jsx";

const ANSWER = "Connections is in the tab bar at the bottom.";

const POINT_AT_CONNECTIONS = [
  "guide/1",
  'goal "connection.create"',
  'focus "nav.connections" "Connections lives down here." side=top',
  'wait target "nav.connections" event=activate timeout=30000',
  'success "This is Connections."',
  "end",
].join("\n");

/** What `@media (max-width: 900px)` does to the rail. */
function narrowTheWindow(): void {
  const rail = document.querySelector<HTMLElement>(".rail");
  if (!rail) throw new Error("the shell rendered no rail to hide");
  rail.style.display = "none";
}

describe("support at phone width", () => {
  afterEach(resetJourney);

  it("points at the tab bar once the rail is gone, and still gets there", async () => {
    const journey = renderJourney(
      fakeAgentAnswering(ANSWER, POINT_AT_CONNECTIONS),
    );
    const { user } = journey;

    // On a desktop the rail row answers for the section.
    expect(resolveGuideTargetElement("nav.connections")?.className).toContain(
      "railtree__row",
    );

    narrowTheWindow();

    // Same semantic id, same registry, other candidate — and the rail row is
    // still in the document, so this is resolution choosing, not the rail
    // having gone away.
    const tab = resolveGuideTargetElement("nav.connections");
    expect(tab?.className).toContain("tabbar__link");
    expect(
      document.querySelector(".rail a[href='/connections']"),
    ).not.toBeNull();
    expect(duplicateGuideTargetMounts()).toEqual([]);

    // The statusline is the one strip that survives every width, so support is
    // still reachable and still answerable.
    await openSupport(user);
    const composer = await screen.findByLabelText<HTMLInputElement>(
      "Ask about this screen",
    );
    await waitFor(() => expect(composer.disabled).toBe(false));
    await askSupport(user, "Where are connections on this phone?");

    await waitFor(() => expect(journey.focused()).toEqual(["nav.connections"]));
    expect(journey.drawn()[0]).toMatchObject({ target: "nav.connections" });

    if (!tab) throw new Error("nothing pointable answers for nav.connections");
    await user.click(tab);

    await waitFor(() => expect(journey.outcomes()).toHaveLength(1));
    expect(journey.outcomes()[0]).toEqual({
      kind: "completed",
      goal: "connection.create",
    });
    expect(await screen.findByLabelText("Search connectors")).toBeTruthy();

    // And the conversation is still readable afterwards.
    const reopened = await openSupport(user);
    expect(within(reopened).getByText(ANSWER)).toBeTruthy();
    expect(within(reopened).getByText("This is Connections.")).toBeTruthy();
  });
});
