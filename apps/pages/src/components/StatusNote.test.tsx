/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StatusNote } from "./StatusNote.js";

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
});
