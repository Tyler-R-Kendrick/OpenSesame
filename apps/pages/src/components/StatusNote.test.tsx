import { cleanup, fireEvent, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusNote } from "./StatusNote.js";

describe("StatusNote", () => {
  afterEach(cleanup);

  it("renders nothing without a message", () => {
    const { container } = render(<StatusNote message={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("announces errors with role=alert", () => {
    render(<StatusNote message={{ tone: "err", text: "It broke." }} />);
    const note = screen.getByRole("alert");
    expect(note.textContent).toContain("It broke.");
    expect(note.className).toContain("note--err");
  });

  it("keeps successes quiet with role=status", () => {
    render(<StatusNote message={{ tone: "ok", text: "Saved." }} />);
    const note = screen.getByRole("status");
    expect(note.textContent).toContain("Saved.");
    expect(note.className).toContain("note--ok");
  });

  it("lets an error be dismissed, and calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(
      <StatusNote
        message={{ tone: "err", text: "It broke." }}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("lets a warning be dismissed", () => {
    render(<StatusNote message={{ tone: "warn", text: "Host is down." }} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Host is down.")).toBeNull();
  });

  it("does not offer dismiss on a success", () => {
    render(<StatusNote message={{ tone: "ok", text: "Saved." }} />);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("shows a new error after the previous one was dismissed", () => {
    const { rerender } = render(
      <StatusNote message={{ tone: "err", text: "First." }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    rerender(<StatusNote message={{ tone: "err", text: "Second." }} />);
    expect(screen.getByRole("alert").textContent).toContain("Second.");
  });

  it("shows the same error again after the parent cleared it", () => {
    const { rerender } = render(
      <StatusNote message={{ tone: "err", text: "It broke." }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    rerender(<StatusNote message={null} />);
    rerender(<StatusNote message={{ tone: "err", text: "It broke." }} />);
    expect(screen.getByRole("alert").textContent).toContain("It broke.");
  });
});
