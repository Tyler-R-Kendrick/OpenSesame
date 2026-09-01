/** @vitest-environment jsdom */

/**
 * What somebody who cannot see the panel is actually told.
 *
 * Four of this feature's states are the kind that get built as pure visual
 * texture — a blinking caret for "thinking", a bar for a download, a red rule
 * for a failure, a tinted card for a live walkthrough. Each assertion below
 * asks for the *words*: a state a screen reader cannot reach is a state that
 * does not exist for the person who most needs the support panel to work.
 */

import {
  fakeAgentAlwaysUnavailable,
  fakeAgentAnswering,
  fakeAgentDownloadable,
  fakeAgentDownloading,
  fakeAgentFailing,
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
  walkthrough,
} from "./harness.js";

async function ask(user: TestUser, question: string): Promise<void> {
  const field = await screen.findByLabelText<HTMLInputElement>(
    "Ask about this screen",
  );
  await waitFor(() => expect(field.disabled).toBe(false));
  await user.type(field, question);
  await user.click(screen.getByRole("button", { name: "Ask" }));
}

afterEach(disposeSupport);

describe("states an assistive technology has to hear", () => {
  it("says it is thinking in words, in a live status, beside a way out", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentHanging() });
    const sheet = await openPanel(user);
    await ask(user, "something slow");

    const pending = await within(sheet).findByRole("status");
    expect(pending.tagName).toBe("OUTPUT");
    expect(pending.textContent).toContain("Thinking");
    // Waiting is not a dead end: the way to stop is a named control, not a
    // second click on the same button.
    expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("reports download progress as text, not only as a bar", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentDownloading(0.4) });
    const sheet = await openPanel(user);

    const read = await within(sheet).findByRole("status");
    expect(read.tagName).toBe("OUTPUT");
    expect(read.textContent).toContain("40%");
    expect(read.textContent).toContain("Downloading the on-device model");
    // The bar is the redundant half: it stays for a sighted person as a
    // glanceable cue, and is hidden from assistive technology, which would
    // otherwise hear "progress bar, 40" with no subject beside a sentence that
    // already says the whole thing.
    const bar = sheet.querySelector("progress.support__progress");
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("aria-hidden")).toBe("true");
    expect(within(sheet).queryAllByRole("progressbar")).toHaveLength(0);
  });

  it("offers the download as a named gesture rather than an ambient fetch", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentDownloadable() });
    const sheet = await openPanel(user);

    expect(
      await within(sheet).findByRole("button", {
        name: "Download the on-device model",
      }),
    ).toBeTruthy();
    expect(within(sheet).queryByRole("progressbar")).toBeNull();
  });

  it("labels the unavailable state in prose, and disables the field that cannot work", async () => {
    const user = userEvent.setup();
    mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
    });
    const sheet = await openPanel(user);

    expect(await within(sheet).findByText(/no on-device model/i)).toBeTruthy();
    const field = within(sheet).getByLabelText<HTMLInputElement>(
      "Ask about this screen",
    );
    // `disabled` is exposed to assistive technology; the placeholder repeats
    // it for anyone reading. Neither is a greyed-out box and nothing else.
    await waitFor(() => expect(field.disabled).toBe(true));
    expect(field.getAttribute("placeholder")).toBe("Written help only");
  });

  it("raises a failure as an alert, in a sentence, with no code in it", async () => {
    const user = userEvent.setup();
    mountSupport({ agent: fakeAgentFailing("AGENT_PROTOCOL_ERROR") });
    const sheet = await openPanel(user);
    await ask(user, "anything");

    const alert = await within(sheet).findByRole("alert");
    expect(alert.textContent).toContain("did not arrive in one piece");
    expect(alert.textContent).not.toContain("AGENT_PROTOCOL_ERROR");
    expect(alert.textContent).not.toContain("_");
  });

  it("puts an answer into a named, polite live region", async () => {
    const user = userEvent.setup();
    mountSupport({
      agent: fakeAgentAnswering("The lock is on the statusline."),
    });
    const sheet = await openPanel(user);
    await ask(user, "where is the lock");

    const thread = await within(sheet).findByRole("region", {
      name: "Conversation",
    });
    expect(thread.getAttribute("aria-live")).toBe("polite");
    expect(
      within(thread).getByText("The lock is on the statusline."),
    ).toBeTruthy();
  });

  it("says a walkthrough's progress and its paused state in words", async () => {
    const user = userEvent.setup();
    mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
      targets: ["shell.lock"],
    });
    await openPanel(user);
    await user.click(walkthrough("Lock the vault"));

    await user.click(
      await screen.findByRole("button", {
        name: "Support — walkthrough in progress",
      }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Support" });
    const status = within(sheet).getByRole("region", {
      name: "Walkthrough in progress",
    });
    expect(status.textContent).toContain("Lock the vault");
    // The tinted card is the decoration; the step count is the fact.
    expect(status.textContent).toMatch(/step \d+ of \d+/);
    expect(status.textContent).not.toContain("paused");

    await user.click(within(status).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(status.textContent).toContain("paused"));
    // Paused loses its own control, and gains the word.
    expect(within(status).queryByRole("button", { name: "Pause" })).toBeNull();
    expect(within(status).getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("names the transport warning as text when an answer will leave the device", async () => {
    const user = userEvent.setup();
    mountSupport({
      agent: fakeAgentAnswering("Anything."),
      transport: "remote",
      warning: "Answers leave this device.",
    });
    const sheet = await openPanel(user);

    expect(
      await within(sheet).findByText("Answers leave this device."),
    ).toBeTruthy();
    // The launcher does not change its name for the transport, so the warning
    // has to be inside the sheet where the question gets typed.
    expect(launcher().getAttribute("aria-label")).toBe("Support");
  });
});
