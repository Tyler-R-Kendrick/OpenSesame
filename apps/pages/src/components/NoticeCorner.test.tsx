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
      const { container } = render(
        <MemoryRouter>
          <NoticeCorner />
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
      expect(
        screen.getByRole("button", { name: "Notifications" }),
      ).toBeTruthy();
      act(() => clearNotices());
      expect(container.firstChild).toBeNull();
    } finally {
      notificationsBarSeams.NotificationsBar = original;
    }
  });

  it("shows a fresh failure's card beside the bell, so a shellless screen never reads as a no-op", () => {
    render(
      <MemoryRouter>
        <NoticeCorner />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => {
      setStatusNotice({
        id: "unlock:error",
        tone: "err",
        title: "Unlock",
        body: "This authenticator did not return a WebAuthn PRF result.",
      });
    });
    // The card is on screen without the sheet being opened — the caret stays
    // where the ceremony left it.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(
      /did not return a WebAuthn PRF result/,
    );
    act(() => {
      setStatusNotice({
        id: "unlock:error",
        tone: "err",
        title: "Unlock",
        body: "Still did not work.",
      });
    });
    expect(screen.getByRole("alert").textContent).toMatch(/Still did not work/);
  });

  it("keeps warn notices behind the bell", () => {
    render(
      <MemoryRouter>
        <NoticeCorner />
      </MemoryRouter>,
    );
    act(() => {
      setStatusNotice({
        id: "host-down",
        tone: "warn",
        title: "Service unavailable",
        body: "Authorization needs a connection.",
      });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Authorization needs a connection.")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Notifications — 1 pending" }),
    ).toBeTruthy();
  });
});
