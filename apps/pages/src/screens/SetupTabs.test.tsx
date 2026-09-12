import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SetupScreen } from "./SetupScreen.js";
import { createSetupSeams } from "./setup/test-seams.js";

const seams = createSetupSeams();
const { completeSetup } = seams;

beforeEach(() => seams.reset());
afterEach(cleanup);

function openSetup(onDone: () => void = vi.fn()): () => void {
  render(<SetupScreen road="setup" onDone={onDone} />);
  return onDone;
}

function heading(): string {
  return screen.getByRole("heading", { level: 1 }).textContent ?? "";
}

describe("the tabs and their skips (ADR 0114)", () => {
  it("walks from backups to sync as steps are skipped, recording each", async () => {
    const onDone = openSetup(vi.fn());
    for (const title of [
      "Where do backups live?",
      "Which connectors are already authorized?",
      "Who runs the model?",
      "How do people sign in?",
      "Should a code follow the key?",
      "What should this vault sync with?",
    ]) {
      expect(heading()).toBe(title);
      fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    }
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
      skipped: ["backups", "connectors", "ai", "identity", "mfa", "sync"],
    });
  });

  it("skip all finishes from wherever the tour is", async () => {
    const onDone = openSetup(vi.fn());
    fireEvent.click(screen.getByRole("tab", { name: "mfa" }));
    expect(heading()).toBe("Should a code follow the key?");
    fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
      skipped: ["mfa", "sync"],
    });
  });

  it("lands on a named tab when a road asks for it", () => {
    render(<SetupScreen road="setup" step="identity" onDone={vi.fn()} />);
    expect(heading()).toBe("How do people sign in?");
    expect(
      screen
        .getByRole("tab", { name: "identity" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("next advances without calling anything skipped, and stops at sync", () => {
    openSetup();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(heading()).toBe("Which connectors are already authorized?");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(heading()).toBe("Who runs the model?");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(heading()).toBe("How do people sign in?");
    // Browsing is not skipping: the record only hears from Skip and Skip all.
    fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
      skipped: ["identity", "mfa", "sync"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "sync" }));
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });
});
