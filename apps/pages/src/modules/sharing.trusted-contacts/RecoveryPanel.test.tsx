/** @vitest-environment jsdom */
import { clearNotices } from "@opensesame/app-core/lib/notices.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecoveryPanel } from "./RecoveryPanel.js";
import {
  type Recovering,
  recovering,
} from "./recovery/recovery.test-support.js";
import {
  declareTargets,
  deskOf,
  elementById,
  serveDesk,
} from "./trusted-contacts.test-support.js";

let undeclare: () => void;
let unserve: () => void = () => undefined;

beforeEach(() => {
  undeclare = declareTargets();
});

afterEach(() => {
  cleanup();
  unserve();
  undeclare();
  clearNotices();
});

async function serve(env: Recovering) {
  unserve();
  unserve = serveDesk(await deskOf(env.recipient));
}

const startKey = () => screen.getByRole("button", { name: "Start a recovery" });

describe("the Recovery panel's head", () => {
  it("has one key, in the panel's keys, and it is the target the walkthrough points at", async () => {
    const env = await recovering();
    await env.recipient.pending.remove(`recovery:${env.started.requestId}`);
    await serve(env);
    render(<RecoveryPanel />);
    await screen.findByRole("img", { name: "No recoveries in progress." });
    const keys = screen.getByRole("group", { name: "Recovery commands" });
    expect(within(keys).getAllByRole("button")).toHaveLength(1);
    expect(startKey().textContent).toBe("");
    expect(startKey().getAttribute("title")).toBe("Start a recovery");
    expect(startKey().getAttribute("data-guide-targets")?.split(" ")).toContain(
      "recovery.start",
    );
    expect(elementById("recovery").getAttribute("aria-label")).toBe("Recovery");
  });
});

describe("a recovery through the panel, by keyboard", () => {
  it("starts from the head key, lands in the new recovery's sheet, and leaves a row with a key to open it again", async () => {
    const env = await recovering();
    await env.recipient.pending.remove(`recovery:${env.started.requestId}`);
    await serve(env);
    render(<RecoveryPanel />);
    await screen.findByRole("img", { name: "No recoveries in progress." });

    startKey().focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", {
      name: "Start a recovery",
    });
    const input = dialog.querySelector("input[type=file]");
    if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
    await userEvent.upload(
      input,
      new File([env.bundleText], "family.json", { type: "application/json" }),
    );
    await within(dialog).findByText("Family");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Send the request" }),
    );

    // The new recovery's own sheet follows, with the request to hand on.
    await screen.findByRole("dialog", { name: "Family recovery" });
    expect(
      screen.queryByRole("dialog", { name: "Start a recovery" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy the request" }),
    ).toBeTruthy();

    // Closing it puts the keyboard where the person came from.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(startKey());
    const row = screen
      .getByRole("heading", { level: 3, name: "Family" })
      .closest("li");
    if (!row) throw new Error("no row");
    expect(row.textContent).toContain("0 approved · 0 released");

    // The row's key opens the same recovery.
    await userEvent.click(
      within(row).getByRole("button", { name: "Open Family recovery" }),
    );
    await screen.findByRole("dialog", { name: "Family recovery" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(
      within(row).getByRole("button", { name: "Open Family recovery" }),
    );
  });

  it("gives a recovery up from its sheet and lands the keyboard on the head key", async () => {
    const env = await recovering();
    await serve(env);
    render(<RecoveryPanel />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Open Family recovery" }),
    );
    await screen.findByRole("dialog", { name: "Family recovery" });
    const giveUp = elementById("recovery-give-up");
    await userEvent.click(giveUp);
    await userEvent.click(giveUp);
    await screen.findByRole("img", { name: "No recoveries in progress." });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(startKey()));
    expect(await env.recipient.pending.list("recovery:")).toEqual([]);
  });
});
