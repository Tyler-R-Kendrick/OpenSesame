/** @vitest-environment jsdom */
import {
  clearNotices,
  dismissNotice,
  listNotices,
} from "@opensesame/app-core/lib/notices.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { type StatusMessage, StatusNote } from "./StatusNote.js";

describe("StatusNote", () => {
  afterEach(() => {
    cleanup();
    clearNotices();
  });

  it("renders nothing without a message", () => {
    const { container } = render(<StatusNote message={null} />);
    expect(container.firstChild).toBeNull();
    expect(listNotices()).toHaveLength(0);
  });

  it("sends an error to the tray and draws nothing in the page", () => {
    const { container } = render(
      <StatusNote message={{ tone: "err", text: "It broke." }} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(listNotices()).toMatchObject([
      { kind: "status", tone: "err", body: "It broke." },
    ]);
  });

  it("sends a warning to the tray as a warning", () => {
    const { container } = render(
      <StatusNote
        title="Host"
        message={{ tone: "warn", text: "Host is down." }}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(listNotices()).toMatchObject([
      { tone: "warn", title: "Host", body: "Host is down." },
    ]);
  });

  it("keeps successes quiet, inline, and out of the tray", () => {
    render(<StatusNote message={{ tone: "ok", text: "Saved." }} />);
    const note = screen.getByRole("status");
    expect(note.textContent).toContain("Saved.");
    expect(note.className).toContain("note--ok");
    expect(listNotices()).toHaveLength(0);
  });

  it("clears its notice when the failure goes away", () => {
    const { rerender } = render(
      <StatusNote message={{ tone: "err", text: "It broke." }} />,
    );
    expect(listNotices()).toHaveLength(1);
    rerender(<StatusNote message={null} />);
    expect(listNotices()).toHaveLength(0);
  });

  it("replaces, never stacks, a second failure", () => {
    const { rerender } = render(
      <StatusNote message={{ tone: "err", text: "First." }} />,
    );
    rerender(<StatusNote message={{ tone: "err", text: "Second." }} />);
    expect(listNotices().map((notice) => notice.body)).toEqual(["Second."]);
  });

  it("clears its notice when it unmounts", () => {
    const { unmount } = render(
      <StatusNote message={{ tone: "err", text: "It broke." }} />,
    );
    expect(listNotices()).toHaveLength(1);
    unmount();
    expect(listNotices()).toHaveLength(0);
  });

  it("keeps a dismissed notice dismissed when an unrelated render rebuilds the message", () => {
    const { rerender } = render(
      <StatusNote message={{ tone: "err", text: "It broke." }} />,
    );
    act(() => dismissNotice(listNotices()[0]?.id ?? ""));
    expect(listNotices()).toHaveLength(0);
    rerender(<StatusNote message={{ tone: "err", text: "It broke." }} />);
    expect(listNotices()).toHaveLength(0);
  });

  it("raises the same sentence again once the failure has cleared in between", () => {
    const { rerender } = render(
      <StatusNote message={{ tone: "err", text: "It broke." }} />,
    );
    act(() => dismissNotice(listNotices()[0]?.id ?? ""));
    rerender(<StatusNote message={null} />);
    rerender(<StatusNote message={{ tone: "err", text: "It broke." }} />);
    expect(listNotices().map((notice) => notice.body)).toEqual(["It broke."]);
  });

  describe("mounted only while a message exists", () => {
    let setMessage: (message: StatusMessage | null) => void = () => undefined;

    function Panel() {
      const [message, set] = useState<StatusMessage | null>(null);
      setMessage = set;
      return message ? <StatusNote message={message} /> : null;
    }

    it("leaves none, then one, never two, as the failure comes and goes", () => {
      render(<Panel />);
      expect(listNotices()).toHaveLength(0);
      act(() => setMessage({ tone: "err", text: "It broke." }));
      expect(listNotices()).toHaveLength(1);
      act(() => setMessage(null));
      expect(listNotices()).toHaveLength(0);
      act(() => setMessage({ tone: "err", text: "It broke." }));
      expect(listNotices()).toHaveLength(1);
    });
  });
});
