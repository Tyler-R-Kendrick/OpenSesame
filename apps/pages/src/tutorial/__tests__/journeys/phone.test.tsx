/** @vitest-environment jsdom */

/**
 * The same walkthrough, on a phone.
 *
 * This app renders each section twice — a rail row on a desktop, a drawer row
 * on a phone — and exactly one of them can be pointed at. So `nav.connections`
 * binds both, and resolution picks whichever can actually be pointed at.
 * Nothing external styles a jsdom document, so the rail is hidden here the way
 * the media query hides it: `display: none`.
 *
 * A phone keeps its sections behind one key, so the walkthrough is two steps
 * rather than one: point at the key, then at the row it opens. That is the
 * honest shape of the journey now, and it exercises resolution twice.
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

const ANSWER = "Connections is behind the sections key at the top.";

const POINT_AT_CONNECTIONS = [
  "guide/1",
  'goal "connection.create"',
  'focus "nav.menu" "Sections live behind here." side=bottom',
  'wait target "nav.menu" event=activate timeout=30000',
  'focus "nav.connections" "And Connections is in here." side=right',
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

describe("support at phone width", { timeout: 20_000 }, () => {
  afterEach(resetJourney);

  it("points at the drawer once the rail is gone, and still gets there", async () => {
    const journey = renderJourney(
      fakeAgentAnswering(ANSWER, POINT_AT_CONNECTIONS),
    );
    const { user } = journey;

    // On a desktop the rail row answers for the section.
    expect(resolveGuideTargetElement("nav.connections")?.className).toContain(
      "railtree__row",
    );

    narrowTheWindow();

    // A phone's sections are behind one key, so that key is what a guide can
    // point at while the drawer is shut — the section rows are not in the
    // document yet, and the rail's copy is present but not pointable.
    expect(resolveGuideTargetElement("nav.menu")).not.toBeNull();
    expect(resolveGuideTargetElement("nav.connections")).toBeNull();
    expect(
      document.querySelector(".rail a[href='/connections']"),
    ).not.toBeNull();

    // Open it and the same semantic id resolves to the other candidate. Same
    // registry, same contract: resolution chooses, the rail has not gone away.
    await user.click(screen.getByRole("button", { name: "Sections" }));
    expect(resolveGuideTargetElement("nav.connections")?.className).toContain(
      "drawer__row",
    );
    expect(duplicateGuideTargetMounts()).toEqual([]);
    await user.keyboard("{Escape}");

    // The statusline is the one strip that survives every width, so support is
    // still reachable and still answerable.
    await openSupport(user);
    const composer = await screen.findByLabelText<HTMLInputElement>(
      "Ask about this screen",
    );
    await waitFor(() => expect(composer.disabled).toBe(false));
    await askSupport(user, "Where are connections on this phone?");

    // Step one points at the key, because that is all a shut drawer offers.
    await waitFor(() => expect(journey.focused()).toEqual(["nav.menu"]));
    expect(journey.drawn()[0]).toMatchObject({ target: "nav.menu" });
    const menu = resolveGuideTargetElement("nav.menu");
    if (!menu) throw new Error("nothing pointable answers for nav.menu");
    await user.click(menu);

    // Step two points at the row the key just put on screen.
    await waitFor(() =>
      expect(journey.focused()).toEqual(["nav.menu", "nav.connections"]),
    );
    const row = resolveGuideTargetElement("nav.connections");
    if (!row) throw new Error("nothing pointable answers for nav.connections");
    await user.click(row);

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
