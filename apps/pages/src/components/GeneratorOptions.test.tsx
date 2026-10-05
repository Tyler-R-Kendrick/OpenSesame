/** @vitest-environment jsdom */
import { defaultGenerator } from "@opensesame/app-core/lib/vault/generators/index.js";
import { DEFAULT_RULES, type PasswordGenerator } from "@opensesame/vault-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratorOptions } from "./GeneratorOptions.js";

afterEach(cleanup);

function Harness({
  start,
  onChange,
}: {
  start: PasswordGenerator;
  onChange?: (next: PasswordGenerator) => void;
}) {
  const [generator, setGenerator] = useState(start);
  return (
    <GeneratorOptions
      generator={generator}
      onChange={(next) => {
        setGenerator(next);
        onChange?.(next);
      }}
    />
  );
}

describe("GeneratorOptions", () => {
  it("draws the rules: length, classes, floors and ambiguity, with its entropy", () => {
    render(<Harness start={defaultGenerator("rules")} />);
    expect(screen.getByLabelText("Length")).toBeTruthy();
    for (const name of ["A–Z", "a–z", "0–9", "Symbols", "Avoid l1IO0"])
      expect(screen.getByLabelText(name)).toBeTruthy();
    expect(screen.getByLabelText("Minimum digits")).toBeTruthy();
    expect(screen.getByLabelText("Minimum symbols")).toBeTruthy();
    expect(screen.getByText(/^≈\d+ bits$/)).toBeTruthy();
  });

  it("reports each change as a whole generator", () => {
    const onChange = vi.fn();
    render(<Harness start={defaultGenerator("rules")} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Length"), {
      target: { value: "40" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "rules", length: 40 }),
    );
    fireEvent.click(screen.getByLabelText("Symbols"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ symbols: false }),
    );
    // A class that is off has no floor to draw.
    expect(screen.queryByLabelText("Minimum symbols")).toBeNull();
    fireEvent.change(screen.getByLabelText("Minimum digits"), {
      target: { value: "4" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ minDigits: 4 }),
    );
  });

  it("draws the passphrase's own options", () => {
    const onChange = vi.fn();
    render(
      <Harness start={defaultGenerator("passphrase")} onChange={onChange} />,
    );
    expect(screen.queryByLabelText("Length")).toBeNull();
    fireEvent.change(screen.getByLabelText("Word count"), {
      target: { value: "7" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "passphrase", words: 7 }),
    );
    fireEvent.click(screen.getByLabelText("Capitalise"));
    fireEvent.change(screen.getByLabelText("Separator"), {
      target: { value: "." },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ capitalize: false, separator: "." }),
    );
  });

  it("draws the rules for Derived, with no counter to type", () => {
    const onChange = vi.fn();
    render(<Harness start={defaultGenerator("derived")} onChange={onChange} />);
    expect(screen.queryByLabelText("Counter")).toBeNull();
    fireEvent.change(screen.getByLabelText("Length"), {
      target: { value: "30" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "derived",
        counter: 0,
        rules: expect.objectContaining({ length: 30 }),
      }),
    );
  });

  it("still draws the rules and a counter for the earlier Sphinx, and nothing for Manual", () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <Harness
        start={{
          id: "sphinx",
          rules: { ...DEFAULT_RULES },
          realm: "example.com",
          counter: 0,
          oprfKeyB64: "k",
        }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Counter"), {
      target: { value: "3" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "sphinx",
        counter: 3,
        realm: "example.com",
      }),
    );
    unmount();
    const { container } = render(
      <Harness start={defaultGenerator("manual")} />,
    );
    expect(container.textContent).toBe("");
  });

  it("states no entropy when no class is chosen", () => {
    render(
      <Harness
        start={{
          id: "rules",
          ...DEFAULT_RULES,
          lower: false,
          upper: false,
          digits: false,
          symbols: false,
        }}
      />,
    );
    expect(screen.queryByText(/bits$/)).toBeNull();
  });
});
