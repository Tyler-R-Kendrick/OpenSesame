/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { UnlockScreen } from "../UnlockScreen.js";
import {
  ANSWERED,
  resetUnlockHarness,
  setupHolder,
  v,
} from "../unlock-screen-harness.js";

beforeEach(resetUnlockHarness);
afterEach(cleanup);

it("keeps the front door free of project navigation", () => {
  v.state = {
    status: "empty",
    header: null,
    lockedOutUntil: null,
    failedAttempts: 0,
    durable: true,
    awaitingSecondStep: false,
  };
  render(<UnlockScreen />);
  expect(screen.getByRole("button", { name: /^Set up your own/ })).toBeTruthy();
  expect(screen.queryByText("About this project")).toBeNull();
  expect(screen.queryByRole("link", { name: "Source code" })).toBeNull();
});

it("keeps a PIN-locked vault free of project navigation", () => {
  setupHolder.current = ANSWERED;
  v.state = {
    status: "locked",
    header: null,
    lockedOutUntil: null,
    failedAttempts: 0,
    durable: true,
    awaitingSecondStep: false,
  };
  v.methods = ["pin"];
  v.preferred = "pin";
  render(<UnlockScreen />);
  expect(screen.getByLabelText("PIN", { exact: true })).toBeTruthy();
  expect(screen.queryByText("About this project")).toBeNull();
  expect(screen.queryByRole("link", { name: "Source code" })).toBeNull();
});
