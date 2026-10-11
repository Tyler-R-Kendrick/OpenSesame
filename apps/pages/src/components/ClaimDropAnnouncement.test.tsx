import { reportClaim } from "@opensesame/app-core/lib/claims/route-model.js";
import {
  clearNotices,
  dismissNotice,
  listNotices,
} from "@opensesame/app-core/lib/notices.js";
/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { NoticeCorner } from "./NoticeCorner.js";

afterEach(() => {
  clearNotices();
  cleanup();
});

describe("ClaimDropAnnouncement", () => {
  it("shows one bar caption and replaces it instead of stacking", () => {
    const { container } = render(<NoticeCorner />);
    act(() => {
      reportClaim("First.");
      reportClaim("Second.");
    });
    const bar = container.querySelector(".notice-corner[data-c]");
    expect(bar?.getAttribute("data-c")).toContain("Second.");
    expect(bar?.getAttribute("data-c")).not.toContain("First.");
  });

  it("clears when the claim notice is dismissed from the tray", () => {
    const { container } = render(<NoticeCorner />);
    act(() => {
      reportClaim("Refused.");
    });
    expect(container.querySelector(".notice-corner[data-c]")).toBeTruthy();
    const id = listNotices().find((n) => n.body === "Refused.")?.id;
    expect(id).toBeTruthy();
    act(() => dismissNotice(id ?? ""));
    expect(container.querySelector(".notice-corner[data-c]")).toBeNull();
  });
});
