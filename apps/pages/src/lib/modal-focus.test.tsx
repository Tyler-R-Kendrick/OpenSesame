/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { type RefObject, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useModalFocus } from "./modal-focus.js";

afterEach(cleanup);

type Wanted = "field" | "absent";

function Modal({
  wanted,
  fallback,
}: {
  wanted: Wanted;
  fallback: boolean;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const absent = useRef<HTMLInputElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const initial: RefObject<HTMLElement | null> =
    wanted === "field" ? field : absent;
  useModalFocus(true, sheet, initial, () => {}, fallback ? close : undefined);
  return (
    <div ref={sheet}>
      <button ref={close} type="button">
        Close
      </button>
      <input ref={field} aria-label="Field" />
    </div>
  );
}

describe("useModalFocus arrival", () => {
  it("focuses the requested element", () => {
    render(<Modal wanted="field" fallback />);
    expect(document.activeElement).toBe(screen.getByLabelText("Field"));
  });

  it("falls back when the requested ref holds no element", () => {
    render(<Modal wanted="absent" fallback />);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close" }),
    );
  });

  it("leaves focus alone when there is no element and no fallback", () => {
    render(<Modal wanted="absent" fallback={false} />);
    expect(document.activeElement).toBe(document.body);
  });
});
