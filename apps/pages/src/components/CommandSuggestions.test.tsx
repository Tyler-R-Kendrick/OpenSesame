/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandSuggestions,
  revealActiveOption,
  useCommandSuggestions,
} from "./CommandSuggestions.js";

function Field() {
  const [value, setValue] = useState("/");
  const suggestions = useCommandSuggestions(value, []);
  return (
    <>
      <input
        aria-label="Command"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          suggestions.setDismissed(false);
        }}
        onFocus={() => suggestions.setFocused(true)}
        onKeyDown={(event) => {
          suggestions.onKeyDown(event, () => setValue("chosen"));
        }}
      />
      {suggestions.open ? (
        <CommandSuggestions
          suggestions={suggestions.suggestions}
          active={suggestions.active}
          onChoose={() => setValue("chosen")}
          onHover={suggestions.setActive}
        />
      ) : null}
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe("command suggestions", () => {
  it("ignores Enter while an IME composition is active", () => {
    render(<Field />);
    const field = screen.getByRole("textbox", { name: "Command" });
    fireEvent.focus(field);
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect((field as HTMLInputElement).value).toBe("/");
    fireEvent.keyDown(field, { key: "Enter" });
    expect((field as HTMLInputElement).value).toBe("chosen");
  });

  it("chooses a row on click and keeps the field on mouse down", () => {
    render(<Field />);
    const field = screen.getByRole("textbox", { name: "Command" });
    fireEvent.focus(field);
    const option = screen.getByRole("option", { name: /Vault/ });
    fireEvent.mouseDown(option);
    expect((field as HTMLInputElement).value).toBe("/");
    fireEvent.click(option);
    expect((field as HTMLInputElement).value).toBe("chosen");
  });

  it("scrolls the list so the active option is inside it", () => {
    const list = document.createElement("div");
    const option = document.createElement("div");
    Object.defineProperty(list, "clientHeight", { value: 100 });
    Object.defineProperty(option, "offsetTop", { value: 200 });
    Object.defineProperty(option, "offsetHeight", { value: 44 });
    list.scrollTop = 0;
    revealActiveOption(list, option);
    expect(list.scrollTop).toBe(144);
    revealActiveOption(list, option);
    expect(list.scrollTop).toBe(144);
  });
});
