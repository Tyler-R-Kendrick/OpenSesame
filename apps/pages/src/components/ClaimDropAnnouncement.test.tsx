import { CLAIM_DROP_BAR_ID } from "@opensesame/app-core/lib/claims/route-model.js";
import {
  clearNotices,
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { NoticeCorner } from "./NoticeCorner.js";

afterEach(() => {
  clearNotices();
  cleanup();
});

describe("ClaimDropAnnouncement", () => {
  it("shows one alert and replaces it instead of stacking", () => {
    render(<NoticeCorner />);
    act(() => {
      setStatusNotice({
        id: CLAIM_DROP_BAR_ID,
        tone: "err",
        title: "Claim",
        body: "First.",
      });
      setStatusNotice({
        id: CLAIM_DROP_BAR_ID,
        tone: "err",
        title: "Drop",
        body: "Second.",
      });
    });
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Second.");
    expect(alert.textContent).not.toContain("First.");
  });

  it("clears when the bar notice is dismissed from the tray", () => {
    render(<NoticeCorner />);
    act(() => {
      setStatusNotice({
        id: CLAIM_DROP_BAR_ID,
        tone: "err",
        title: "Claim",
        body: "Refused.",
      });
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    act(() => dismissNotice(CLAIM_DROP_BAR_ID));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
