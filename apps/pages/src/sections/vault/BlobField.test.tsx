/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BlobInput } from "./BlobField.js";

afterEach(() => {
  cleanup();
});

describe("BlobInput", () => {
  it("offers Choose file and keeps the picker out of tab order", () => {
    const { container } = render(
      <BlobInput id="bytes" value="" onChange={() => undefined} />,
    );
    expect(screen.getByRole("button", { name: "Choose file" })).toBeTruthy();
    const picker = container.querySelector("input[type='file']");
    expect(picker).toBeInstanceOf(HTMLInputElement);
    expect(picker?.hasAttribute("tabindex")).toBe(false);
    expect(picker?.hasAttribute("hidden")).toBe(true);
  });
});
