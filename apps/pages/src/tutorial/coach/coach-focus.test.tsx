/** @vitest-environment jsdom */

import { cleanup, render } from "@testing-library/react";
import { type ReactElement, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useCoachFocus } from "./use-coach-behavior.js";

afterEach(cleanup);

function Card(): ReactElement {
  const card = useRef<HTMLElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useCoachFocus(true, "1:step:1", card, primary);
  return (
    <section ref={card}>
      <button type="button" ref={primary}>
        Next
      </button>
    </section>
  );
}

function outside(tag: "input" | "button"): HTMLElement {
  const element = document.createElement(tag);
  document.body.appendChild(element);
  element.focus();
  return element;
}

describe("the card's first move of focus", () => {
  it("takes it from the page body", () => {
    const { getByRole } = render(<Card />);
    expect(document.activeElement).toBe(getByRole("button", { name: "Next" }));
  });

  it("takes it from the launcher that started the tour", () => {
    const launcher = outside("button");
    launcher.className = "support-launch";
    const { getByRole } = render(<Card />);
    expect(document.activeElement).toBe(getByRole("button", { name: "Next" }));
    launcher.remove();
  });

  it("takes it from a non-text control, as a person-started tour does", () => {
    const row = outside("button");
    const { getByRole } = render(<Card />);
    expect(document.activeElement).toBe(getByRole("button", { name: "Next" }));
    row.remove();
  });

  it("leaves it with someone typing in the page", () => {
    const field = outside("input");
    const { getByRole } = render(<Card />);
    expect(document.activeElement).toBe(field);
    expect(document.activeElement).not.toBe(
      getByRole("button", { name: "Next" }),
    );
    field.remove();
  });

  it("takes it from the Support panel's own field", () => {
    const panel = document.createElement("section");
    panel.setAttribute("aria-label", "Support");
    const field = document.createElement("input");
    panel.appendChild(field);
    document.body.appendChild(panel);
    field.focus();
    const { getByRole } = render(<Card />);
    expect(document.activeElement).toBe(getByRole("button", { name: "Next" }));
    panel.remove();
  });
});
