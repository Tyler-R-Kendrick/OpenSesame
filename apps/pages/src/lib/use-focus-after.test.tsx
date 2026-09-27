/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { type FocusTarget, byId, useFocusAfter } from "./use-focus-after.js";

let request: (target: FocusTarget) => void = () => undefined;
let settle: () => void = () => undefined;

function Harness() {
  const [busy, setBusy] = useState(true);
  request = useFocusAfter(busy);
  settle = () => setBusy(false);
  return (
    <>
      <button type="button" id="landing">
        Landing
      </button>
      <input aria-label="Elsewhere" />
    </>
  );
}

afterEach(cleanup);

it("lands focus on the named control once the change settles, when focus was lost", () => {
  render(<Harness />);
  if (document.activeElement instanceof HTMLElement)
    document.activeElement.blur();
  act(() => request(byId("landing")));
  expect(document.activeElement).toBe(document.body);
  act(() => settle());
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Landing" }),
  );
});

it("leaves focus where the person moved it while the change was in flight", () => {
  render(<Harness />);
  act(() => request(byId("landing")));
  const elsewhere = screen.getByLabelText("Elsewhere");
  elsewhere.focus();
  act(() => settle());
  expect(document.activeElement).toBe(elsewhere);
});

it("asks a lookup for its target only once the change settles", () => {
  let landing: HTMLElement | null = null;
  render(<Harness />);
  if (document.activeElement instanceof HTMLElement)
    document.activeElement.blur();
  act(() => request(() => landing));
  landing = screen.getByRole("button", { name: "Landing" });
  act(() => settle());
  expect(document.activeElement).toBe(landing);
});
