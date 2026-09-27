/** @vitest-environment jsdom */
/**
 * "Reset this browser?": closed it is a question; open it is the consequence
 * and two keys. Keep and Escape close it with focus back on the question;
 * erase runs the reset and then — only then — leaves for a first visit.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResetBrowser, resetBrowserSeams } from "./ResetBrowser.js";

const original = { ...resetBrowserSeams };

afterEach(() => {
  cleanup();
  Object.assign(resetBrowserSeams, original);
});

function openPanel(): void {
  fireEvent.click(screen.getByRole("button", { name: "Reset this browser?" }));
}

describe("ResetBrowser", () => {
  it("opens on the safe key and closes back onto the question", () => {
    render(<ResetBrowser />);
    openPanel();

    const keep = screen.getByRole("button", { name: "Keep it" });
    expect(document.activeElement).toBe(keep);
    expect(
      screen.getByRole("button", { name: "Erase everything in this browser" }),
    ).toBeTruthy();

    fireEvent.click(keep);
    const question = screen.getByRole("button", {
      name: "Reset this browser?",
    });
    expect(document.activeElement).toBe(question);
  });

  it("Escape closes the panel without erasing anything", () => {
    const reset = vi.fn();
    resetBrowserSeams.reset = reset;
    render(<ResetBrowser />);
    openPanel();

    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });

    expect(reset).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Reset this browser?" }),
    ).toBeTruthy();
  });

  it("erases, then leaves for a first visit once the reset has finished", async () => {
    const order: string[] = [];
    let finish: () => void = () => undefined;
    resetBrowserSeams.reset = () =>
      new Promise((resolve) => {
        order.push("reset");
        finish = () => resolve({ cleared: [], failed: [], kept: [] });
      });
    resetBrowserSeams.firstVisit = () => {
      order.push("firstVisit");
    };
    render(<ResetBrowser />);
    openPanel();

    const erase = screen.getByRole("button", {
      name: "Erase everything in this browser",
    });
    fireEvent.click(erase);

    expect(order).toEqual(["reset"]);
    expect(erase.hasAttribute("disabled")).toBe(true);
    finish();
    await vi.waitFor(() => expect(order).toEqual(["reset", "firstVisit"]));
  });
});
