import {
  clearNotices,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { act, cleanup, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { NoticeCorner } from "./NoticeCorner.js";
import { notificationsBarSeams } from "./NotificationsBar.js";

describe("NoticeCorner", () => {
  afterEach(cleanup);

  it("is absent while the tray is empty", () => {
    const { container } = render(<NoticeCorner />);
    expect(container.firstChild).toBeNull();
  });

  it("appears with a bell when a failure is raised, and goes when it clears", () => {
    const original = notificationsBarSeams.NotificationsBar;
    notificationsBarSeams.NotificationsBar = () => (
      <button type="button" aria-label="Notifications" />
    );
    try {
      const { container } = render(<NoticeCorner />);
      act(() => {
        setStatusNotice({
          id: "unlock:error",
          tone: "err",
          title: "Unlock",
          body: "That did not work.",
        });
      });
      expect(
        screen.getByRole("button", { name: "Notifications" }),
      ).toBeTruthy();
      act(() => clearNotices());
      expect(container.firstChild).toBeNull();
    } finally {
      notificationsBarSeams.NotificationsBar = original;
    }
  });
});
