/** @vitest-environment jsdom */

/**
 * What assistive technology is told the support sheet *is*.
 *
 * Every assertion here goes through an accessible-name query rather than a
 * class or a selector: the panel is a `<section>` wearing `role="dialog"`, so
 * its name comes from an attribute that a refactor can silently drop, and the
 * only test that would notice is one that asks for the control by its name.
 */

import {
  fakeAgentAlwaysUnavailable,
  fakeAgentAnswering,
} from "@opensesame/support-agent";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  disposeSupport,
  launcher,
  mountSupport,
  openPanel,
  walkthrough,
} from "./harness.js";

afterEach(disposeSupport);

describe("support dialog semantics", () => {
  it("names the launcher and says what it opens", async () => {
    mountSupport({ agent: fakeAgentAnswering("Anything.") });

    const affordance = launcher();
    expect(affordance.getAttribute("aria-haspopup")).toBe("dialog");
    // The pip is the colour half of the signal, and colour is never the whole
    // of it — so the pip is hidden and the name carries the state instead.
    expect(affordance.querySelector("[aria-hidden='true']")).not.toBeNull();
  });

  it("opens one modal dialog, named, headed and closable", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Anything.") });
    const sheet = await openPanel(user);

    // `getByRole(..., { name })` is the whole assertion: it resolves the
    // accessible name the same way a screen reader does.
    expect(screen.getAllByRole("dialog", { name: "Support" })).toHaveLength(1);
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(
      within(sheet).getByRole("heading", { level: 2, name: "Support" }),
    ).toBeTruthy();
    expect(
      within(sheet).getAllByRole("button", { name: "Close" }),
    ).toHaveLength(1);

    // The vault keymap stands down on exactly this query, so a sheet that
    // stopped matching it would hand every key back to the vault underneath.
    expect(
      document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
    ).toHaveLength(1);
  });

  it("puts the scrim outside the dialog rather than inside its reading order", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Anything.") });
    const sheet = await openPanel(user);

    const closers = screen.getAllByRole("button", { name: "Close" });
    const outside = closers.filter((node) => !sheet.contains(node));
    // The scrim is a second control named "Close". It is deliberately not in
    // the dialog, so the dialog's own reading order holds one way out.
    expect(outside).toHaveLength(1);
    expect(sheet.contains(outside[0] ?? sheet)).toBe(false);
  });

  it("labels every field programmatically, not by placeholder", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Anything.") });
    const sheet = await openPanel(user);

    const ask = within(sheet).getByLabelText("Ask about this screen");
    const search = within(sheet).getByLabelText("Search help");
    expect(ask.tagName).toBe("INPUT");
    expect(search.tagName).toBe("INPUT");
    // A placeholder is not a name: both fields keep a real <label> even where
    // the placeholder happens to repeat it.
    expect(ask.getAttribute("id")).toBeTruthy();
    expect(search.getAttribute("id")).toBeTruthy();
  });

  it("names each region of the sheet so it can be navigated by landmark", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Anything.") });
    const sheet = await openPanel(user);

    expect(
      within(sheet).getByRole("region", { name: "Written help" }),
    ).toBeTruthy();
    expect(
      within(sheet).getByRole("region", { name: "Walkthroughs" }),
    ).toBeTruthy();
    // Present before anything is said. A live region created in the same paint
    // as its first message is not reliably announced, so an empty one has to be
    // waiting for the first answer to land in.
    const conversation = within(sheet).getByRole("region", {
      name: "Conversation",
    });
    expect(conversation.getAttribute("aria-live")).toBe("polite");
    expect(conversation.textContent).toBe("");

    await user.click(
      within(sheet).getByRole("button", { name: "Where do I lock the vault?" }),
    );
    expect(
      await within(sheet).findByRole("region", { name: "Conversation" }),
    ).toBeTruthy();
  });

  it("never orders the sheet with a positive tabindex", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Anything.") });
    const sheet = await openPanel(user);

    const ordered = [
      ...sheet.querySelectorAll<HTMLElement>("[tabindex]"),
    ].filter((element) => element.tabIndex > 0);
    expect(ordered).toEqual([]);
  });

  it("says a walkthrough is live in the launcher's name, not only its colour", async () => {
    const user = userEvent.setup();
    mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
      targets: ["shell.lock"],
    });
    await openPanel(user);
    await user.click(walkthrough("Lock the vault"));

    const live = await screen.findByRole("button", {
      name: "Support — walkthrough in progress",
    });
    expect(live.getAttribute("title")).toBe(
      "Support — walkthrough in progress",
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull(),
    );

    // Reopening finds the walkthrough's own controls under a named region.
    await user.click(live);
    const sheet = await screen.findByRole("dialog", { name: "Support" });
    const status = within(sheet).getByRole("region", {
      name: "Walkthrough in progress",
    });
    expect(within(status).getByRole("button", { name: "Stop" })).toBeTruthy();
  });
});
