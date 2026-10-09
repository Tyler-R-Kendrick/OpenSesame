/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { version } from "../../../package.json";
import { ReleaseNotes } from "./ReleaseNotes.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubViewport(stacked: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList => ({
      matches: stacked && query === "(max-width: 1099px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }),
  );
}

it("opens the newest release on arrival beside the card on a wide screen", () => {
  stubViewport(false);
  render(<ReleaseNotes />);
  // "Release notes" is the column's title above the rows, not a row label.
  expect(
    screen.getByRole("heading", { level: 2, name: "Release notes" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("complementary", { name: "Release notes" }),
  ).toBeTruthy();
  const newestBtn = screen.getByRole("button", { name: version });
  const priorBtn = screen.getByRole("button", { name: "0.0.1" });
  expect(newestBtn.getAttribute("aria-expanded")).toBe("true");
  expect(priorBtn.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("heading", { name: "Works" })).toBeTruthy();

  fireEvent.click(priorBtn);
  expect(priorBtn.getAttribute("aria-expanded")).toBe("true");
  expect(newestBtn.getAttribute("aria-expanded")).toBe("false");
});

it("starts collapsed on a stacked gate, toggles releases, and keeps at most one row expanded", () => {
  stubViewport(true);
  render(<ReleaseNotes />);
  expect(
    screen.getByRole("complementary", { name: "Release notes" }),
  ).toBeTruthy();
  const newestBtn = screen.getByRole("button", { name: version });
  const priorBtn = screen.getByRole("button", { name: "0.0.1" });
  expect(newestBtn.getAttribute("aria-expanded")).toBe("false");
  expect(priorBtn.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("heading", { name: "Works" })).toBeNull();

  fireEvent.click(newestBtn);
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
