/** @vitest-environment jsdom */

/**
 * Every control in the sheet, driven by keys alone.
 *
 * Reaching a control with `.focus()` proves nothing about tab order, so each
 * flow below tabs to its control the way a person would and activates it with
 * Enter. The panel is a support surface: somebody using it is, by definition,
 * already stuck, and a control that only answers to a pointer is the worst
 * possible place to find that out.
 */

import {
  fakeAgentAlwaysUnavailable,
  fakeAgentAnswering,
  fakeAgentHanging,
} from "@opensesame/support-agent";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  type TestUser,
  disposeSupport,
  launcher,
  mountSupport,
  openPanel,
  reachable,
  tabTo,
  walkthrough,
} from "./harness.js";

async function askByKeyboard(user: TestUser, question: string): Promise<void> {
  const field = await screen.findByLabelText<HTMLInputElement>(
    "Ask about this screen",
  );
  await waitFor(() => expect(field.disabled).toBe(false));
  await tabTo(user, field);
  await user.keyboard(question);
  // Implicit submission: the composer is a form, so Enter in the field sends
  // it. Nobody has to find the Ask button to ask a question.
  await user.keyboard("{Enter}");
}

afterEach(disposeSupport);

describe("keyboard operability", () => {
  it("opens and closes the sheet without a pointer", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Anything.") });

    const affordance = launcher();
    await tabTo(user, affordance);
    await user.keyboard("{Enter}");
    const sheet = await screen.findByRole("dialog", { name: "Support" });

    const close = within(sheet).getByRole("button", { name: "Close" });
    await tabTo(user, close);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull(),
    );
    expect(document.activeElement).toBe(affordance);
  });

  it("asks and receives an answer with keys only", async () => {
    const user = userEvent.setup();
    mountSupport({
      agent: fakeAgentAnswering("The lock is on the statusline."),
    });
    await openPanel(user);
    await askByKeyboard(user, "where is the lock");

    expect(
      await screen.findByText("The lock is on the statusline."),
    ).toBeTruthy();
  });

  it("cancels a question in flight with keys only", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentHanging() });
    await openPanel(user);
    await askByKeyboard(user, "something slow");

    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await tabTo(user, cancel);
    await user.keyboard("{Enter}");

    expect(await screen.findByText("Stopped.")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull(),
    );
  });

  it("clears the conversation with keys only", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Forgettable.") });
    await openPanel(user);
    await askByKeyboard(user, "a question");
    await screen.findByText("Forgettable.");

    const clear = screen.getByRole("button", { name: "Clear conversation" });
    await tabTo(user, clear);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.queryByText("Forgettable.")).toBeNull());
  });

  it("opens a written help topic with keys only, on a browser with no model", async () => {
    const user = userEvent.setup();
    mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
    });
    const sheet = await openPanel(user);

    const topic = within(sheet).getByRole("button", {
      name: "Where do I lock the vault?",
    });
    await tabTo(user, topic);
    await user.keyboard("{Enter}");

    expect(
      await screen.findByText(/Locking drops the vault keys held in memory/),
    ).toBeTruthy();
  });

  it("searches the written help and starts a walkthrough with keys only", async () => {
    const user = userEvent.setup();
    const harness = mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
      targets: ["shell.lock"],
    });
    const sheet = await openPanel(user);

    const search = within(sheet).getByLabelText("Search help");
    await tabTo(user, search);
    await user.keyboard("healthy");
    expect(
      await within(sheet).findByRole("button", {
        name: "How do I tell whether OpenSesame is healthy?",
      }),
    ).toBeTruthy();

    const start = walkthrough("Lock the vault");
    await tabTo(user, start);
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const step = harness.driver.records()[0]?.steps[0];
      expect(step?.element).toBe(harness.fixtures.element("shell.lock"));
    });
  });

  it("offers nothing that only a pointer can use", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentAnswering("Anything.") });
    const sheet = await openPanel(user);

    // Everything the trap can reach is a control the platform already makes
    // operable — no `div` wearing an onClick, no `role="button"` stand-in.
    const kinds = new Set(reachable(sheet).map((element) => element.tagName));
    expect([...kinds].sort()).toEqual(["BUTTON", "INPUT"]);
    expect(sheet.querySelectorAll('[role="button"]')).toHaveLength(0);
    expect(sheet.querySelectorAll("[onclick]")).toHaveLength(0);

    // And every one of them says what it is. A nameless button is a control
    // only a sighted pointer user can identify.
    expect(within(sheet).queryAllByRole("button", { name: "" })).toEqual([]);

    // The query above is worth nothing unless it can actually find one, so
    // put a nameless button in the sheet and watch it be caught.
    const anonymous = document.createElement("button");
    anonymous.type = "button";
    sheet.appendChild(anonymous);
    expect(within(sheet).queryAllByRole("button", { name: "" })).toEqual([
      anonymous,
    ]);
    anonymous.remove();
  });
});
