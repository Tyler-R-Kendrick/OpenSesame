import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearNotices, pushNotice, setStatusNotice } from "../lib/notices.js";
import {
  NotificationsBar,
  notificationsBarDependencies,
} from "./NotificationsBar.js";

const beginSignIn = vi.fn();
const stashCurrentSession = vi.fn();
Object.assign(notificationsBarDependencies, {
  beginSignIn,
  stashCurrentSession,
});

afterEach(() => {
  cleanup();
  clearNotices();
  beginSignIn.mockReset();
  stashCurrentSession.mockReset();
});

describe("NotificationsBar", () => {
  it("stays quiet when nothing is waiting", () => {
    render(
      <MemoryRouter>
        <NotificationsBar />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("button", { name: "Notifications — none" }),
    ).toBeTruthy();
  });

  it("shows a pending guest claim and can start the claim sign-in", () => {
    pushNotice({
      kind: "guest_claim",
      title: "Claim this guest session",
      body: "Complete the claim ceremony.",
      userCode: "WORD-WORD",
    });
    render(
      <MemoryRouter>
        <NotificationsBar />
      </MemoryRouter>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Notifications — 1 pending" }),
    );
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByText("WORD-WORD")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to claim" }));
    expect(stashCurrentSession).toHaveBeenCalledTimes(1);
    expect(beginSignIn).toHaveBeenCalledTimes(1);
  });

  it("shows a status notice with its retry, repair, and dismiss actions", () => {
    const retry = vi.fn();
    setStatusNotice({
      id: "host-down",
      tone: "warn",
      title: "Host API unavailable",
      body: "Host authorization needs the Host API.",
      ceremony: "host",
      ceremonyLabel: "Repair the Host connection",
      retry,
      retryLabel: "Try again",
    });
    render(
      <MemoryRouter>
        <NotificationsBar />
      </MemoryRouter>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Notifications — 1 pending" }),
    );
    expect(screen.getByText("Host API unavailable")).toBeTruthy();
    expect(
      screen.getByText("Host authorization needs the Host API."),
    ).toBeTruthy();
    // Repair opens the Host ceremony in place — never a route change.
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Repair the Host connection" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Host API unavailable")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Notifications — none" }),
    ).toBeTruthy();
  });

  it("announces an error-tone status notice as an alert", () => {
    setStatusNotice({
      id: "connections-load",
      tone: "err",
      title: "Connections could not load",
      body: "fetch failed",
    });
    render(
      <MemoryRouter>
        <NotificationsBar />
      </MemoryRouter>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Notifications — 1 pending" }),
    );
    expect(screen.getByRole("alert").textContent).toMatch(
      /Connections could not load/,
    );
  });
});
