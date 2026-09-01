/** @vitest-environment jsdom */

/**
 * A browser that cannot run a model, in a deployment with no endpoint either.
 *
 * This is the case the design is answerable for: the knowledge is checked-in
 * data, and a model only makes it conversational. So the panel still opens,
 * says plainly why nothing can be asked, and hands over the written help, the
 * search over it and the walkthroughs — none of which needs anything to
 * answer. The last assertion of the first story is the one that matters: the
 * agent was never called at all.
 */

import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GUIDE_ERROR_TEXT, UNAVAILABLE_TEXT } from "../../ui/messages.js";
import { openSupport, renderJourney, resetJourney } from "./harness.jsx";

/** Starts the walkthrough offered beside a named goal in the panel. */
async function showMe(
  panel: HTMLElement,
  goalTitle: string,
): Promise<HTMLElement> {
  const region = within(panel).getByRole("region", { name: "Walkthroughs" });
  const row = within(region).getByText(goalTitle).closest("article");
  if (!row) throw new Error(`no walkthrough offered for ${goalTitle}`);
  return within(row).getByRole("button", { name: "Show me" });
}

describe("support on a browser that has no model to run", () => {
  afterEach(resetJourney);

  it("opens, says why, and still helps — without asking anything", async () => {
    const agent = fakeAgentAlwaysUnavailable("platform_unsupported");
    const journey = renderJourney(agent, { transport: "none" });
    const { user } = journey;

    const panel = await openSupport(user);

    // The honest reason, not a spinner and not a dead composer with no
    // explanation beside it.
    expect(
      await within(panel).findByText(UNAVAILABLE_TEXT.platform_unsupported),
    ).toBeTruthy();
    const composer = await screen.findByLabelText<HTMLInputElement>(
      "Ask about this screen",
    );
    expect(composer.disabled).toBe(true);

    const help = within(panel).getByRole("region", { name: "Written help" });
    expect(
      within(help).getByRole("button", { name: "Where do I lock the vault?" }),
    ).toBeTruthy();
    expect(
      within(help).getByRole("button", {
        name: "How do I connect a provider?",
      }),
    ).toBeTruthy();

    // Search is a substring over authored prose — no index, no model.
    await user.type(within(panel).getByLabelText("Search help"), "import");
    expect(
      await within(help).findByRole("button", {
        name: "How do I bring items in from another password manager?",
      }),
    ).toBeTruthy();
    expect(
      within(help).queryByRole("button", {
        name: "Where do I lock the vault?",
      }),
    ).toBeNull();
    await user.clear(within(panel).getByLabelText("Search help"));
    expect(
      await within(help).findByRole("button", {
        name: "Where do I lock the vault?",
      }),
    ).toBeTruthy();

    // Reading a topic puts the authored answer in the transcript, as an answer.
    await user.click(
      within(help).getByRole("button", {
        name: "How do I connect a provider?",
      }),
    );
    expect(
      await screen.findByText(/Search the catalog, open the provider's page/),
    ).toBeTruthy();

    // And a named goal runs a real walkthrough, over the real registry.
    await user.click(
      await showMe(panel, "Check whether OpenSesame is healthy"),
    );
    await waitFor(() =>
      expect(journey.focused()).toEqual(["shell.connectivity"]),
    );
    await waitFor(() =>
      expect(journey.navigations()).toEqual(["/vault/health"]),
    );
    expect(
      await screen.findByRole("heading", { name: "Password health" }),
    ).toBeTruthy();

    // Nothing in any of that went looking for a model.
    expect(agent.calls()).toEqual([]);
  });

  /**
   * A defect, recorded as it behaves today rather than as it should.
   *
   * Five of the seven authored goals are offered on every route and navigate
   * to their own section before pointing at something there. A model's output
   * is compiled against the vocabulary of the route the person is on now — it
   * may only name what it was shown — but a checked-in walkthrough is compiled
   * against the whole registry, because it names a control on the screen it is
   * about to navigate to. Scoping both the same way meant the panel offered
   * walkthroughs that refused to start from the screen offering them.
   *
   * Same parser, same validator, same budgets; only the vocabulary differs, and
   * it differs because the provenance does.
   */
  it("runs a cross-route walkthrough from the screen that offers it", async () => {
    const journey = renderJourney(
      fakeAgentAlwaysUnavailable("platform_unsupported"),
      { transport: "none" },
    );
    const { user } = journey;

    const panel = await openSupport(user);
    await user.click(await showMe(panel, "Connect a provider"));

    // It walks from the vault to Connections and points at the picker there.
    await waitFor(() =>
      expect(journey.focused()).toEqual(["connections.provider-picker"]),
    );
    expect(journey.navigations()).toContain("/connections");
    expect(screen.queryByRole("alert")).toBeNull();

    resetJourney();

    // And still runs when the person is already there, navigating to the route
    // it is on, which is a no-op rather than an error.
    const onConnections = renderJourney(
      fakeAgentAlwaysUnavailable("platform_unsupported"),
      { transport: "none", at: "/connections" },
    );
    const reopened = await openSupport(onConnections.user);
    await onConnections.user.click(
      await showMe(reopened, "Connect a provider"),
    );

    await waitFor(() =>
      expect(onConnections.focused()).toEqual(["connections.provider-picker"]),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
