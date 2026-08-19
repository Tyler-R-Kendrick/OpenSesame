import { cleanup, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

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
    expect(note.textContent).toBe("It broke.");
    expect(note.className).toContain("note--err");
  });

  it("keeps successes quiet with role=status", () => {
    render(<StatusNote message={{ tone: "ok", text: "Saved." }} />);
    const note = screen.getByRole("status");
    expect(note.textContent).toBe("Saved.");
    expect(note.className).toContain("note--ok");
  });
});
