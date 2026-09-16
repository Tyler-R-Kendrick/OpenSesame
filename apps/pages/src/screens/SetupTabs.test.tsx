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

function selectedTab(): string {
  return screen.getByRole("tab", { selected: true }).textContent?.trim() ?? "";
}

describe("the tabs and their skips (ADR 0114)", () => {
  it("walks from connectors to sync as steps are skipped, recording each", async () => {
    const onDone = openSetup(vi.fn());
    for (const tab of [
      "connectors",
      "backups",
      "ai",
      "identity",
      "mfa",
      "sync",
    ]) {
      expect(selectedTab()).toBe(tab);
      fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    }
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
      skipped: ["connectors", "backups", "ai", "identity", "mfa", "sync"],
    });
  });

  it("skip all finishes from wherever the tour is", async () => {
    const onDone = openSetup(vi.fn());
    fireEvent.click(screen.getByRole("tab", { name: "mfa" }));
    expect(selectedTab()).toBe("mfa");
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
    expect(selectedTab()).toBe("identity");
    expect(
      screen
        .getByRole("tab", { name: "identity" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("back returns to the previous step without recording a skip", () => {
    openSetup();
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(selectedTab()).toBe("backups");
    fireEvent.click(screen.getByRole("button", { name: "Previous step" }));
    expect(selectedTab()).toBe("connectors");
    expect(completeSetup).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("button", {
          name: "Previous step",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("next advances without calling anything skipped, and stops at sync", () => {
    openSetup();
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(selectedTab()).toBe("backups");
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(selectedTab()).toBe("ai");
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(selectedTab()).toBe("identity");
    // Browsing is not skipping: the record only hears from Skip and Skip all.
    fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
      skipped: ["identity", "mfa", "sync"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "sync" }));
    expect(screen.queryByRole("button", { name: "Next step" })).toBeNull();
  });
});
