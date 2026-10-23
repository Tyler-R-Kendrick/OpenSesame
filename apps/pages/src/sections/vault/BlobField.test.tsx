/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BlobInput } from "./BlobField.js";

afterEach(() => {
  cleanup();
});

describe("BlobInput", () => {
  it("says so when this browser has no private file store", () => {
    const { container } = render(
      <BlobInput id="bytes" value="" onChange={() => undefined} />,
    );
    const picker = container.querySelector("input[type='file']");
    if (!(picker instanceof HTMLInputElement)) throw new Error("no picker");
    fireEvent.change(picker, {
      target: { files: [new File(["x"], "x.txt")] },
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "cannot store file attachments",
    );
  });

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
