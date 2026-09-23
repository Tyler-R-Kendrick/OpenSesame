import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearNotices,
  pushNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { createItem } from "@opensesame/app-core/lib/vault/model.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
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

  it.skip("shows a status notice with its retry, repair, and dismiss actions", () => {
    const retry = vi.fn();
    setStatusNotice({
      id: "host-down",
      tone: "warn",
      title: "Service unavailable",
      body: "Authorization needs a connection.",
      ceremony: "identity",
      ceremonyLabel: "Repair the Identity connection",
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
    expect(screen.getByText("Service unavailable")).toBeTruthy();
    expect(screen.getByText("Authorization needs a connection.")).toBeTruthy();
    // Repair opens the Host ceremony in place — never a route change.
    expect(screen.queryByRole("link")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Repair the connection" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Service unavailable")).toBeNull();
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
