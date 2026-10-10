/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import {
  dismissClaimDropBanner,
  showClaimDropBanner,
} from "@opensesame/app-core/lib/claims/claim-drop-banner.js";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimDropAnnouncement } from "./ClaimDropAnnouncement.js";

afterEach(() => {
  dismissClaimDropBanner();
  cleanup();
});

describe("ClaimDropAnnouncement", () => {
  it("shows one alert and replaces it instead of stacking", () => {
    render(<ClaimDropAnnouncement />);
    act(() => {
      showClaimDropBanner({ title: "Claim", body: "First." });
      showClaimDropBanner({ title: "Drop", body: "Second." });
    });
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(screen.getByText("Second.")).toBeTruthy();
    expect(screen.queryByText("First.")).toBeNull();
  });

  it("dismisses from the key and from Escape", () => {
    render(<ClaimDropAnnouncement />);
    act(() => {
      showClaimDropBanner({ title: "Claim", body: "Refused." });
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => {
      showClaimDropBanner({ title: "Drop", body: "Again." });
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
