/** @vitest-environment jsdom */
/**
 * "Reset this browser?": closed it is a question; open it is the consequence
 * and two keys. Keep and Escape close it with focus back on the question;
 * erase runs the reset and leaves for a first visit only when nothing was
 * left behind — otherwise the panel stays and names what remains.
 */

import type { BrowserResetReport } from "@opensesame/app-core/lib/browser-reset.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ResetBrowser, resetBrowserSeams } from "./ResetBrowser.js";

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
  screen.getByRole("button", { name: "Erase everything in this browser" });

describe("ResetBrowser", () => {
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
    const firstVisit = vi.fn();
    Object.assign(resetBrowserSeams, { reset, firstVisit });
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
    await vi.waitFor(() => expect(firstVisit).toHaveBeenCalledTimes(1));
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
    resetBrowserSeams.firstVisit = () => {
      order.push("firstVisit");
    };
    render(<ResetBrowser />);
    openPanel();

    const erase = eraseKey();
    fireEvent.click(erase);

    expect(order).toEqual(["reset"]);
    expect(erase.hasAttribute("disabled")).toBe(true);
    finish();
    await vi.waitFor(() => expect(order).toEqual(["reset", "firstVisit"]));
  });

  it("stays and names what would not go, with a way on either way", async () => {
    const reports: BrowserResetReport[] = [
      {
        cleared: ["session", "web_storage"],
        failed: ["origin_files", "databases"],
        kept: [],
      },
      CLEAN,
    ];
    const reset = vi.fn(async () => reports.shift() ?? CLEAN);
    const firstVisit = vi.fn();
    Object.assign(resetBrowserSeams, { reset, firstVisit });
    render(<ResetBrowser />);
    openPanel();

    fireEvent.click(eraseKey());

    const again = await screen.findByRole("button", { name: "Erase again" });
    expect(firstVisit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(again);
    expect(
      screen.getByRole("img", { name: "Vaults and settings: not erased" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "History backups: not erased" }),
    ).toBeTruthy();
    // Still here, so Escape cannot pretend it was undone.
    fireEvent.keyDown(again, { key: "Escape" });
    expect(screen.getByRole("list", { name: "Still in this browser" }));

    fireEvent.click(again);
    await vi.waitFor(() => expect(firstVisit).toHaveBeenCalledTimes(1));
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("offline, names the shell it kept and still lets the person start over", async () => {
    const firstVisit = vi.fn();
    Object.assign(resetBrowserSeams, {
      reset: async (): Promise<BrowserResetReport> => ({
        cleared: ["session", "origin_files", "databases", "web_storage"],
        failed: [],
        kept: ["push_subscription", "caches", "service_workers"],
      }),
      firstVisit,
    });
    render(<ResetBrowser />);
    openPanel();

    fireEvent.click(eraseKey());

    await screen.findByRole("list", { name: "Still in this browser" });
    expect(firstVisit).not.toHaveBeenCalled();
    for (const name of [
      "Notifications: still subscribed",
      "Offline app: kept while offline",
      "Offline worker: kept while offline",
    ]) {
      expect(screen.getByRole("img", { name })).toBeTruthy();
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Start as a first visit" }),
    );
    expect(firstVisit).toHaveBeenCalledTimes(1);
  });
});
