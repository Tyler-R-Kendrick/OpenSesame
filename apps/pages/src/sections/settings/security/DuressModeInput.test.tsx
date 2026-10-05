/** @vitest-environment jsdom */
import type { DuressMode } from "@opensesame/app-core/lib/duress/settings/modes/index.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ModeInput } from "./DuressModeInput.js";

afterEach(cleanup);

const base = {
  id: "t",
  label: "t",
  opens: "t",
  consent: "t",
  presentation: "locked",
} as const;

function Harness({
  input,
  rows,
}: {
  input: DuressMode["input"];
  rows?: readonly { id: string; label: string; detail: string }[];
}) {
  const [value, setValue] = useState("");
  return (
    <>
      <ModeInput
        mode={{ ...base, input }}
        busy={false}
        value={value}
        onValue={setValue}
        rows={rows}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe("ModeInput", () => {
  it("draws nothing for a mode with no input", () => {
    const { container } = render(<Harness input={{ kind: "none" }} />);
    expect(container.querySelector("input,textarea")).toBeNull();
  });

  it("types a text and a confirmation word as they are", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        input={{ kind: "confirm", id: "w", label: "Type WIPE", word: "WIPE" }}
      />,
    );
    await user.type(screen.getByLabelText("Type WIPE"), "wipe");
    expect(screen.getByTestId("value").textContent).toBe("wipe");
  });

  it("offers a choice as radios and reports the option's value, not its label", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        input={{
          kind: "choice",
          id: "h",
          label: "For how long",
          options: [
            { value: "1", label: "An hour" },
            { value: "24", label: "A day" },
          ],
        }}
      />,
    );
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(
      screen
        .getAllByRole("radio")
        .some((r) => r instanceof HTMLInputElement && r.checked),
    ).toBe(false);
    await user.click(screen.getByLabelText("A day"));
    expect(screen.getByTestId("value").textContent).toBe("24");
  });

  it("takes items as lines in one field", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        input={{
          kind: "items",
          id: "i",
          label: "Items",
          min: 1,
          max: 5,
          maxLength: 40,
        }}
      />,
    );
    await user.type(screen.getByLabelText("Items"), "one{Enter}two");
    expect(screen.getByTestId("value").textContent).toBe("one\ntwo");
  });

  it("takes a pick as one switch per row, every row hidden, and reports the ids left shown in order", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        input={{ kind: "pick", id: "p", label: "Hidden items", min: 1, max: 3 }}
        rows={[
          { id: "a", label: "Alpha", detail: "Login" },
          { id: "b", label: "Beta", detail: "Card" },
          { id: "c", label: "Gamma", detail: "Secret" },
        ]}
      />,
    );
    const rows = screen.getAllByRole("switch");
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
      "true",
    ]);
    expect(screen.getByTestId("value").textContent).toBe("");
    await user.click(screen.getByRole("switch", { name: "Hide Gamma" }));
    await user.click(screen.getByRole("switch", { name: "Hide Alpha" }));
    expect(screen.getByTestId("value").textContent).toBe("a\nc");
    await user.click(screen.getByRole("switch", { name: "Hide Alpha" }));
    expect(screen.getByTestId("value").textContent).toBe("c");
  });

  it("draws a pick with no rows as an empty list, never a form control that does nothing", () => {
    render(
      <Harness
        input={{ kind: "pick", id: "p", label: "Hidden items", min: 1, max: 3 }}
      />,
    );
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });
});
