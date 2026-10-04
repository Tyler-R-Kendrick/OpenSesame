/** @vitest-environment jsdom */

/**
 * One gate for both tabs: what the Ask tab lists is what the Tutorials tab
 * would offer. A tour of a row this device has no use for, or of a section
 * that is not drawn, is not a question to ask.
 */

import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  disposeSupport,
  mountSupport,
  openPanel,
} from "../__tests__/a11y/harness.js";

afterEach(disposeSupport);

async function askTitles(route: string): Promise<readonly string[]> {
  const user = userEvent.setup();
  mountSupport({
    agent: fakeAgentAlwaysUnavailable("no_local_model"),
    transport: "none",
    route,
    targets: ["shell.lock"],
  });
  const sheet = await openPanel(user);
  const questions = await within(sheet).findByRole("region", {
    name: "Questions",
  });
  return within(questions)
    .getAllByRole("button")
    .map((button) => button.textContent ?? "");
}

describe("the Ask tab", () => {
  it("lists no tour that only the library offers", async () => {
    const titles = await askTitles("/settings");
    // Every `feature.*` section tour is library-only.
    expect(titles).not.toContain("Turn on Identity");
    expect(titles).not.toContain("Turn on the Wallet");
  });

  it("hides what this device cannot use", async () => {
    const titles = await askTitles("/settings");
    // No account, no install to make: the tours would point at nothing.
    expect(titles).not.toContain("Sign out of this device");
    expect(titles).not.toContain("Sign in as somebody else");
    expect(titles).not.toContain("Install this app on the device");
    expect(titles).not.toContain(
      "Add a passkey or authenticator app to your account",
    );
  });

  it("still lists what fits the screen", async () => {
    const titles = await askTitles("/vault");
    expect(titles.some((title) => /lock the vault/i.test(title))).toBe(true);
  });
});

describe("written help with no walkthrough", () => {
  it("is answered, and offers no Show me", async () => {
    const user = userEvent.setup();
    mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
    });
    const sheet = await openPanel(user);
    const search = within(sheet).getByLabelText("Search the written help");
    await user.type(search, "unlock the vault");
    const row = await within(sheet).findByRole("button", {
      name: "How do I unlock the vault?",
    });
    const topic = row.closest("article");
    expect(topic).not.toBeNull();
    if (topic) {
      expect(
        within(topic).queryByRole("button", { name: "Show me" }),
      ).toBeNull();
    }
  });
});
