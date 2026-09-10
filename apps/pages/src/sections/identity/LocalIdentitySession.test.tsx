/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as sessions from "../../lib/local-sessions.js";
import { useLocalSessionPresentation } from "./LocalIdentitySession.js";

function Presentation() {
  const { message, error } = useLocalSessionPresentation(
    "test-tomb",
    "test-person",
  );
  return (
    <>
      <output>{message}</output>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("replaces prior status when current session validation fails", async () => {
  const read = vi
    .spyOn(sessions, "currentLocalIdentitySession")
    .mockResolvedValue(null);
  render(<Presentation />);
  await screen.findByText("No active local session.");
  read.mockRejectedValue(new Error("Storage unavailable"));
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await screen.findByRole("alert");
  expect(screen.getByRole("status").textContent).toBe(
    "Local session unavailable.",
  );
  read.mockResolvedValue(null);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByRole("status").textContent).toBe(
    "No active local session.",
  );
});
