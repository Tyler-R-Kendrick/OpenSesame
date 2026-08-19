import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fed = vi.hoisted(() => ({
  completeSignIn: vi.fn(),
}));

vi.mock("../lib/federation.js", () => ({
  FederationError: class FederationError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "FederationError";
      this.code = code;
    }
  },
  completeSignIn: fed.completeSignIn,
}));

import { FederationError } from "../lib/federation.js";
import { FederationReturn } from "./FederationReturn.js";

function renderReturn() {
  return render(
    <MemoryRouter initialEntries={["/?code=abc&state=xyz"]}>
      <Routes>
        <Route path="/" element={<FederationReturn />} />
        <Route path="/settings" element={<p>settings landed</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("FederationReturn", () => {
  beforeEach(() => {
    fed.completeSignIn.mockReset();
  });

  afterEach(cleanup);

  it("shows progress while the sign-in completes", () => {
    fed.completeSignIn.mockReturnValue(new Promise(() => {}));
    renderReturn();
    expect(screen.getByText("Finishing sign-in…")).toBeTruthy();
  });

  it("returns to the page that started sign-in", async () => {
    fed.completeSignIn.mockResolvedValue({ returnTo: "/settings" });
    renderReturn();
    expect(await screen.findByText("settings landed")).toBeTruthy();
  });

  it("falls back to the app root when there is no returnTo", async () => {
    fed.completeSignIn.mockResolvedValue(null);
    renderReturn();
    // Navigated to "/", which still hosts this screen; no error shown.
    await waitFor(() => expect(fed.completeSignIn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces federation errors with a way back", async () => {
    fed.completeSignIn.mockRejectedValue(
      new FederationError("access_denied", "Upstream refused the login."),
    );
    renderReturn();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sign-in failed");
    expect(alert.textContent).toContain("Upstream refused the login.");
    // The way back does not re-attempt sign-in.
    fireEvent.click(screen.getByRole("button", { name: "Back to OpenSesame" }));
    expect(fed.completeSignIn).toHaveBeenCalledTimes(1);
  });

  it("surfaces plain errors verbatim", async () => {
    fed.completeSignIn.mockRejectedValue(new Error("network unreachable"));
    renderReturn();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("network unreachable");
  });

  it("uses a generic message for non-Error failures", async () => {
    fed.completeSignIn.mockRejectedValue("weird");
    renderReturn();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sign-in failed.");
  });
});
