/** @vitest-environment jsdom */
/**
 * "Reset this browser?": closed it is a question; open it is the consequence
 * and two keys. Keep and Escape close it with focus back on the question;
 * erase runs the reset and then — only then, and always — leaves for a
 * fresh document, carrying whatever the reset left behind.
 */

import type { BrowserResetReport } from "@opensesame/app-core/lib/browser-reset.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ResetBrowser } from "./ResetBrowser.js";
import { resetBrowserSeams } from "./reset-browser-run.js";

const original = { ...resetBrowserSeams };

afterEach(() => {
  cleanup();
  Object.assign(resetBrowserSeams, original);
});

const CLEAN: BrowserResetReport = { cleared: [], failed: [], kept: [] };

function openPanel(): void {
  fireEvent.click(screen.getByRole("button", { name: "Reset this browser?" }));
}

const eraseKey = () =>
  screen.getByRole("button", { name: "Erase this browser" });

describe("ResetBrowser", () => {
  it("states the place and the facts, and wears no wash, kicker or caption", () => {
    render(<ResetBrowser />);
    openPanel();
    const dialog = screen.getByRole("dialog", { name: "Reset this browser" });
    // The title is said once; the card names what it erases instead.
    expect(screen.getAllByText(/Reset this browser/)).toHaveLength(2);
    expect(dialog.querySelector(".found--ask")).toBeTruthy();
    expect(dialog.querySelector(".found--attn, .found__top")).toBeNull();
    expect(dialog.querySelector(".sheet__foot, .sheet__head p")).toBeNull();
    const facts = [...dialog.querySelectorAll("dt")].map(
      (dt) => dt.textContent,
    );
    expect(facts).toEqual(["Vaults", "With them", "After", "Untouched"]);
    expect(eraseKey().className).toBe("go go--danger");
    expect(eraseKey().textContent).toBe("");
  });

  it("opens on the safe key and closes back onto the question", () => {
    render(<ResetBrowser />);
    openPanel();

    const keep = screen.getByRole("button", { name: "Keep it" });
    expect(document.activeElement).toBe(keep);
    expect(eraseKey()).toBeTruthy();

    fireEvent.click(keep);
    const question = screen.getByRole("button", {
      name: "Reset this browser?",
    });
    expect(document.activeElement).toBe(question);
  });

  it("Escape closes the question onto the link, goes no further, and arms nothing", async () => {
    const reset = vi.fn(async () => CLEAN);
    const leave = vi.fn();
    Object.assign(resetBrowserSeams, { reset, leave });
    // The screen behind the panel listens on the document.
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    onTestFinished(() => document.removeEventListener("keydown", outer));
    render(<ResetBrowser />);
    openPanel();

    fireEvent.keyDown(screen.getByRole("button", { name: "Keep it" }), {
      key: "Escape",
    });

    const question = screen.getByRole("button", {
      name: "Reset this browser?",
    });
    expect(screen.queryByRole("group")).toBeNull();
    expect(document.activeElement).toBe(question);
    // Handled here: the screen behind it never saw the key.
    expect(outer).not.toHaveBeenCalled();

    // Reopened, it asks again from the safe key; nothing ran in between.
    openPanel();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Keep it" }),
    );
    expect(eraseKey().hasAttribute("disabled")).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    fireEvent.click(eraseKey());
    await vi.waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("erases, then leaves for a first visit once a clean reset has finished", async () => {
    const order: string[] = [];
    let finish: () => void = () => undefined;
    resetBrowserSeams.reset = () =>
      new Promise((resolve) => {
        order.push("reset");
        finish = () => resolve(CLEAN);
      });
    resetBrowserSeams.leave = () => {
      order.push("leave");
    };
    render(<ResetBrowser />);
    openPanel();

    const erase = eraseKey();
    fireEvent.click(erase);

    expect(order).toEqual(["reset"]);
    expect(erase.hasAttribute("disabled")).toBe(true);
    finish();
    await vi.waitFor(() => expect(order).toEqual(["reset", "leave"]));
  });

  it("leaves even when the reset left something, carrying what it left", async () => {
    const left: BrowserResetReport = {
      cleared: ["session", "origin_files", "web_storage"],
      failed: ["databases"],
      kept: ["push_subscription", "caches", "service_workers"],
    };
    const leave = vi.fn();
    Object.assign(resetBrowserSeams, { reset: async () => left, leave });
    render(<ResetBrowser />);
    openPanel();

    fireEvent.click(eraseKey());

    await vi.waitFor(() => expect(leave).toHaveBeenCalledWith(left));
    // Nothing here offers to stay: the stale, halted tab is never used.
    expect(
      screen.queryByRole("list", { name: "Still in this browser" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Erase again" })).toBeNull();
  });
});
