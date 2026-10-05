/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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

  it("draws no Duress or Travel section, nothing that says they are there", () => {
    decoyHeader();
    const { container } = render(<UnlockMethodsPanel />);
    expect(screen.queryByText("Duress")).toBeNull();
    expect(screen.queryByText("Travel")).toBeNull();
    expect(container.querySelector("#duress-after-key")).toBeNull();
    expect(container.querySelector("#travel-after-key")).toBeNull();
  });
});

/**
 * A person who came in by the front door's Skip has a guest vault with no key.
 * Duress and Travel need a kept vault, so a guest is shown both, and their
 * Add key sets the key first, the way the authenticator row does; without
 * them the page never says the features exist.
 */
describe("Duress and Travel for a guest with no key", () => {
  it("draws both sections, each with a key that acts", () => {
    guestHeader();
    const { container } = render(<UnlockMethodsPanel />);
    const duress = container.querySelector("#duress-after-key");
    const travel = container.querySelector("#travel-after-key");
    expect(duress?.textContent).toContain("Duress code");
    expect(travel?.textContent).toContain("Leave items at home");
    for (const section of [duress, travel]) {
      expect(section?.textContent).toContain("After a key.");
      expect(section?.querySelector("button")).not.toBeNull();
    }
  });

  it("opens the sheet that adds the first key from either one", () => {
    guestHeader();
    const { container } = render(<UnlockMethodsPanel />);
    for (const id of ["#duress-after-key", "#travel-after-key"]) {
      const key = container.querySelector(`${id} button`);
      expect(key).not.toBeNull();
      if (key) fireEvent.click(key);
      // The key sheet is the one the Unlock methods rows open.
      expect(screen.getByRole("dialog")).toBeTruthy();
      const [close] = within(screen.getByRole("dialog")).getAllByRole(
        "button",
        { name: "Close" },
      );
      if (close) fireEvent.click(close);
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  });
});
