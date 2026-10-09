/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FormCommit } from "./FormCommit.js";

afterEach(() => cleanup());

describe("FormCommit", () => {
  it("puts the disabled reason on the commit key's accessible name", () => {
    render(
      <FormCommit
        label="Ask to join"
        disabled
        disabledReason="Enter your name"
      />,
    );
    const key = screen.getByRole("button", {
      name: "Ask to join. Enter your name",
    });
    expect(key.hasAttribute("disabled")).toBe(true);
  });
});
