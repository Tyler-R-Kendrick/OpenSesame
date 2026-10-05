/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { UnlockMethodsPanel } from "./UnlockMethodsPanel.js";
import {
  decoyHeader,
  guestHeader,
  installUnlockSeams,
} from "./unlock-methods-panel.test-support.js";

const restoreSeams = installUnlockSeams();
afterAll(restoreSeams);
afterEach(cleanup);

/**
 * A decoy exists so that someone made to unlock cannot be told apart from an
 * ordinary unlock; a sentence that says "you are a guest" is the tell.
 */
describe("Unlock methods in a duress decoy", () => {
  it("says nothing about being a guest", () => {
    decoyHeader();
    render(<UnlockMethodsPanel />);
    expect(screen.queryByText(/You are a guest/)).toBeNull();
    expect(screen.queryByText(/not kept on this device/)).toBeNull();
  });

  it("still tells an ordinary guest, so the copy is not lost", () => {
    guestHeader();
    render(<UnlockMethodsPanel />);
    expect(screen.getByText(/You are a guest/)).toBeTruthy();
  });
});
