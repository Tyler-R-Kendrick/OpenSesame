import { screen } from "@testing-library/react";
import { expect } from "vitest";

/** A button that must not be on the unlock screen. */
export function noButton(name: string | RegExp): void {
  expect(screen.queryByRole("button", { name })).toBeNull();
}
