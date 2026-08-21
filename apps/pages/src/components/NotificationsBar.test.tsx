import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

const beginSignIn = vi.hoisted(() => vi.fn());

vi.mock("../lib/federation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/federation.js")>();
  return { ...actual, beginSignIn };
});

import { clearNotices, pushNotice } from "../lib/notices.js";
import { NotificationsBar } from "./NotificationsBar.js";

afterEach(() => {
  cleanup();
  clearNotices();
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
});
