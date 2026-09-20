/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { version } from "../../../package.json";
import { ReleaseNotes } from "./ReleaseNotes.js";

afterEach(() => {
  cleanup();
});

it("opens the newest release and keeps only one row expanded", () => {
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

  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByText(/ADR|Host|Vercel Connect|backend/i)).toBeNull();
});
