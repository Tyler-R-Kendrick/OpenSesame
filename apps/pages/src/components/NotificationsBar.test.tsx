import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearNotices, pushNotice, setStatusNotice } from "../lib/notices.js";
import { createItem } from "../lib/vault/model.js";
import { vaultStore } from "../lib/vault/store.js";
import {
  NotificationsBar,
  notificationsBarDependencies,
} from "./NotificationsBar.js";

const beginSignIn = vi.fn();
const defaultUseVault = notificationsBarDependencies.useVault;
Object.assign(notificationsBarDependencies, {
  beginSignIn,
});

afterEach(() => {
  cleanup();
  clearNotices();
  beginSignIn.mockReset();
  notificationsBarDependencies.useVault = defaultUseVault;
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
    expect(beginSignIn).toHaveBeenCalledTimes(1);
  });

  it("keeps password-health findings in the global notifications panel", () => {
    const login = createItem("login");
    login.password = "letmein";
    notificationsBarDependencies.useVault = () => ({
      ...vaultStore.getSnapshot(),
      items: [login],
    });
    render(
      <MemoryRouter>
        <NotificationsBar />
      </MemoryRouter>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Notifications — 1 pending" }),
    );
    expect(screen.getByText("1 of 1 passwords need attention.")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Review passwords" })
        .getAttribute("href"),
    ).toBe("/vault/health");
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

  it("moves focus into the sheet on open and back to the bell on close", () => {
    render(
      <MemoryRouter>
        <NotificationsBar />
      </MemoryRouter>,
    );
    const bell = screen.getByRole("button", { name: "Notifications — none" });
    bell.focus();
    fireEvent.click(bell);
    const sheet = screen.getByRole("dialog", { name: "Notifications" });
    expect(sheet.contains(document.activeElement)).toBe(true);
    const close = screen.getAllByRole("button", { name: "Close" }).at(-1);
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(bell);
  });
});
