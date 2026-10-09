/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { version } from "../../../package.json";
import { ReleaseNotes } from "./ReleaseNotes.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function stubMatchMedia(narrow: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: narrow && query.includes("max-width"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  stubMatchMedia(false);
});

it("opens the newest on arrival (wide), toggles releases, and keeps at most one row expanded", () => {
  render(<ReleaseNotes />);
  expect(
    screen.getByRole("complementary", { name: "Release notes" }),
  ).toBeTruthy();
  const newestBtn = screen.getByRole("button", {
    name: `Release notes · ${version}`,
  });
  const priorBtn = screen.getByRole("button", { name: "0.0.1" });
  expect(newestBtn.getAttribute("aria-expanded")).toBe("true");
  expect(priorBtn.getAttribute("aria-expanded")).toBe("false");
  const newestPanel = document.getElementById(
    newestBtn.getAttribute("aria-controls") ?? "",
  );
  if (!newestPanel) throw new Error("expected newest panel");
  expect(
    within(newestPanel).getByRole("heading", { name: "Works" }),
  ).toBeTruthy();
  expect(
    within(newestPanel).getByText(/Continue as guest, or sign in with Google/),
  ).toBeTruthy();

  fireEvent.click(priorBtn);
  expect(priorBtn.getAttribute("aria-expanded")).toBe("true");
  expect(newestBtn.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("Sealed vault on this device")).toBeTruthy();
  expect(
    screen.queryByText(/Continue as guest, or sign in with Google/),
  ).toBeNull();

  fireEvent.click(newestBtn);
  expect(newestBtn.getAttribute("aria-expanded")).toBe("true");
  expect(priorBtn.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(newestBtn);
  expect(newestBtn.getAttribute("aria-expanded")).toBe("false");
  expect(priorBtn.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("heading", { name: "Works" })).toBeNull();
  expect(
    document.getElementById(newestBtn.getAttribute("aria-controls") ?? ""),
  ).toBeNull();

  fireEvent.click(priorBtn);
  fireEvent.click(priorBtn);
  expect(priorBtn.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Sealed vault on this device")).toBeNull();

  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByText(/ADR|Host|Vercel Connect|backend/i)).toBeNull();
});

it("starts collapsed on narrow so the corner dial keeps its empty band", () => {
  stubMatchMedia(true);
  render(<ReleaseNotes />);
  const newestBtn = screen.getByRole("button", {
    name: `Release notes · ${version}`,
  });
  expect(newestBtn.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("heading", { name: "Works" })).toBeNull();
});
