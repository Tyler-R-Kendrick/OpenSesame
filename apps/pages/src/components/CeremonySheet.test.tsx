/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CeremonySheet } from "./CeremonySheet.js";

afterEach(cleanup);

describe("CeremonySheet", () => {
  it("frames a ceremony as a named dialog with its foot", () => {
    render(
      <CeremonySheet
        title="Turn on travel mode"
        mark={<span>mark</span>}
        foot="Nothing leaves yet."
        onClose={() => {}}
      >
        <p>the card</p>
      </CeremonySheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Turn on travel mode" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("the card")).toBeTruthy();
    expect(screen.getByText("Nothing leaves yet.")).toBeTruthy();
  });

  it("leaves no foot when it has nothing to say", () => {
    render(
      <CeremonySheet title="Sheet" mark={null} onClose={() => {}}>
        <p>card</p>
      </CeremonySheet>,
    );
    expect(document.querySelector(".sheet__foot")).toBeNull();
  });

  it("closes from the close key, the scrim and Escape, and takes focus in", () => {
    const onClose = vi.fn();
    render(
      <CeremonySheet title="Sheet" mark={null} onClose={onClose}>
        <p>card</p>
      </CeremonySheet>,
    );
    const close = screen.getAllByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(
      close.find((key) => key.classList.contains("icon-btn")),
    );
    for (const key of close) fireEvent.click(key);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("keeps focus in the field being typed in when its parent re-renders", () => {
    // The parent hands a new onClose on every render, as a panel's does.
    function Harness() {
      const [text, setText] = useState("");
      return (
        <CeremonySheet title="Sheet" mark={null} onClose={() => setText("")}>
          <input
            aria-label="Return code"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </CeremonySheet>
      );
    }
    render(<Harness />);
    const field = screen.getByLabelText("Return code");
    field.focus();
    fireEvent.change(field, { target: { value: "A" } });
    fireEvent.change(field, { target: { value: "AB" } });
    expect(document.activeElement).toBe(field);
    expect((field as HTMLInputElement).value).toBe("AB");
  });
});
