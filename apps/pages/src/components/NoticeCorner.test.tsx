import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearNotices,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { AppRoot } from "../app-root.js";
import { NoticeCorner } from "./NoticeCorner.js";
import { notificationsBarSeams } from "./NotificationsBar.js";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);

function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("NoticeCorner", () => {
  afterEach(() => {
    cleanup();
    clearNotices();
  });

  it("is a block in the document flow, never an overlay", () => {
    const block = rule(".notice-corner");
    expect(block).not.toMatch(/position\s*:/);
    expect(block).not.toMatch(/z-index\s*:/);
    expect(block).toMatch(/justify-content:\s*flex-end/);
  });

  it("sits before the screen body in AppRoot, so it cannot cover it", () => {
    const notificationsBar = notificationsBarSeams.NotificationsBar;
    notificationsBarSeams.NotificationsBar = () => (
      <button type="button" aria-label="Notifications" />
    );
    try {
      const { container } = render(
        <MemoryRouter>
          <AppRoot
            slots={{
              hasAuthResponse: () => true,
              FederationReturn: () => (
                <button type="button" className="signin__skip">
                  Skip
                </button>
              ),
            }}
          />
        </MemoryRouter>,
      );
      act(() => {
        setStatusNotice({
          id: "unlock:error",
          tone: "err",
          title: "Unlock",
          body: "That did not work.",
        });
      });
      const corner = container.querySelector(".notice-corner");
      const skip = container.querySelector(".signin__skip");
      if (!corner || !skip) throw new Error("corner and skip must both render");
      expect(
        corner.compareDocumentPosition(skip) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      notificationsBarSeams.NotificationsBar = notificationsBar;
    }
  });

  it("is absent while the tray is empty", () => {
    const { container } = render(<NoticeCorner />);
    expect(container.firstChild).toBeNull();
  });

  it("appears with a bell when a failure is raised, and goes when it clears", () => {
    const original = notificationsBarSeams.NotificationsBar;
    notificationsBarSeams.NotificationsBar = () => (
      <button type="button" aria-label="Notifications" />
    );
    try {
      const { container } = render(<NoticeCorner />);
      act(() => {
        setStatusNotice({
          id: "unlock:error",
          tone: "err",
          title: "Unlock",
          body: "That did not work.",
        });
      });
      expect(
        screen.getByRole("button", { name: "Notifications" }),
      ).toBeTruthy();
      act(() => clearNotices());
      expect(container.firstChild).toBeNull();
    } finally {
      notificationsBarSeams.NotificationsBar = original;
    }
  });
});
