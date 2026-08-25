/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearNotices, listNotices } from "./notices.js";
import { useStatusNotice } from "./use-status-notice.js";

import type { StatusNoticeInput } from "./notices.js";

function Probe({ notice }: { notice: StatusNoticeInput | null }) {
  useStatusNotice(notice);
  return null;
}

afterEach(() => {
  cleanup();
  clearNotices();
});

describe("useStatusNotice", () => {
  it("pushes nothing while the condition is off", () => {
    render(<Probe notice={null} />);
    expect(listNotices()).toEqual([]);
  });

  it("mirrors the condition: present while mounted, gone on unmount", () => {
    const retry = vi.fn();
    const { unmount } = render(
      <Probe
        notice={{
          id: "identity-session",
          tone: "err",
          title: "t",
          body: "b",
          retry,
          retryLabel: "Try again",
        }}
      />,
    );
    const notice = listNotices().find((n) => n.id === "identity-session");
    expect(notice?.tone).toBe("err");
    expect(notice?.retryLabel).toBe("Try again");
    notice?.retry?.();
    expect(retry).toHaveBeenCalledTimes(1);
    unmount();
    expect(listNotices()).toEqual([]);
  });

  it("clears the notice when the condition turns off in place", () => {
    const input: StatusNoticeInput = {
      id: "catalog-stale",
      tone: "warn",
      title: "t",
      body: "b",
    };
    const { rerender } = render(<Probe notice={input} />);
    expect(listNotices()).toHaveLength(1);
    rerender(<Probe notice={null} />);
    expect(listNotices()).toEqual([]);
  });

  it("replaces the notice when its wording changes", () => {
    const input: StatusNoticeInput = {
      id: "catalog-stale",
      tone: "warn",
      title: "t",
      body: "first",
    };
    const { rerender } = render(<Probe notice={input} />);
    rerender(<Probe notice={{ ...input, body: "second" }} />);
    const notices = listNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toBe("second");
  });
});
