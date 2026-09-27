/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { useFocusAfter } from "./use-focus-after.js";

let request: (id: string) => void = () => undefined;
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
  (document.activeElement as HTMLElement | null)?.blur();
  act(() => request("landing"));
  expect(document.activeElement).toBe(document.body);
  act(() => settle());
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Landing" }),
  );
});

it("leaves focus where the person moved it while the change was in flight", () => {
  render(<Harness />);
  act(() => request("landing"));
  const elsewhere = screen.getByLabelText("Elsewhere");
  elsewhere.focus();
  act(() => settle());
  expect(document.activeElement).toBe(elsewhere);
});
