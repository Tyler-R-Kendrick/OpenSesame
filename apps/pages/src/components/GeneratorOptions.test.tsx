/** @vitest-environment jsdom */
import { defaultGenerator } from "@opensesame/app-core/lib/vault/generators/index.js";
import { DEFAULT_RULES, type PasswordGenerator } from "@opensesame/vault-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratorOptions, describeGenerator } from "./GeneratorOptions.js";

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
  it("is closed to a line that says what it will make, and the options open from it", () => {
    const { container } = render(<Harness start={defaultGenerator("rules")} />);
    const more = container.querySelector("details");
    expect(more?.open).toBe(false);
    expect(more?.querySelector("summary")?.textContent).toBe(
      "20 characters: letters, numbers, symbols",
    );
  });

  it("draws the rules in plain words: length, character types, fewest of each, look-alikes and a strength word", () => {
    render(<Harness start={defaultGenerator("rules")} />);
    expect(screen.getByLabelText("Length")).toBeTruthy();
    for (const name of [
      "Capital letters",
      "Lowercase letters",
      "Numbers",
      "Symbols",
      "Avoid look-alike characters",
    ])
      expect(screen.getByLabelText(name)).toBeTruthy();
    expect(screen.getByLabelText("Fewest numbers")).toBeTruthy();
    expect(screen.getByLabelText("Fewest symbols")).toBeTruthy();
    expect(screen.getByText("Excellent")).toBeTruthy();
    // Nothing the person reads is a character string or a bit count.
    expect(screen.queryByText(/l1IO0|bits/)).toBeNull();
  });

  it("explains the look-alike option in common words", () => {
    render(<Harness start={defaultGenerator("rules")} />);
    expect(
      screen.getByLabelText("Avoid look-alike characters").closest("label")
        ?.title,
    ).toMatch(/easy to mix up/);
  });

  it("describes each generator in a line", () => {
    expect(describeGenerator({ id: "manual" })).toBe("");
    expect(describeGenerator(defaultGenerator("passphrase"))).toMatch(
      /^\d+ words/,
    );
    expect(
      describeGenerator({
        id: "rules",
        ...DEFAULT_RULES,
        upper: false,
        digits: false,
        symbols: false,
      }),
    ).toBe("20 characters: lowercase letters");
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
    expect(screen.queryByLabelText("Fewest symbols")).toBeNull();
    fireEvent.change(screen.getByLabelText("Fewest numbers"), {
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
