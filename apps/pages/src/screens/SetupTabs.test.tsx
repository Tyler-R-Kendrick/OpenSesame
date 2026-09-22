import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SetupScreen, setupScreenDependencies } from "./SetupScreen.js";
import { resetDouble } from "./capabilities/test-support.js";
import { SETUP_PANEL_FIXTURE } from "./setup/panel-fixture.js";
import { createSetupSeams } from "./setup/test-seams.js";

vi.mock("../lib/configuration/capabilities-ports.js", async () => {
  const { fakePortsModule } = await import(
    "./capabilities/composition-ports-double.js"
  );
  const { double } = await import("./capabilities/test-support.js");
  return fakePortsModule(double);
});

const seams = createSetupSeams();
const { completeSetup } = seams;

beforeEach(() => {
  seams.reset();
  resetDouble();
  // The tabs after `capabilities` are whatever applied capabilities
  // registered. This fixture stands in for three module owners.
  setupScreenDependencies.useSetupPanels = () => SETUP_PANEL_FIXTURE;
});
afterEach(cleanup);

function openSetup(onDone: () => void = vi.fn()): () => void {
  render(<SetupScreen onDone={onDone} />);
  return onDone;
}

function selectedTab(): string {
  return screen.getByRole("tab", { selected: true }).textContent?.trim() ?? "";
}

describe("the tabs and their skips (ADR 0114)", () => {
  it("walks from capabilities to the last registered panel as steps are skipped, recording each", async () => {
    const onDone = openSetup(vi.fn());
    for (const tab of ["capabilities", "connectors", "identity", "mfa"]) {
      expect(selectedTab()).toBe(tab);
      fireEvent.click(screen.getByRole("button", { name: "Skip this step" }));
    }
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
      skipped: ["capabilities", "connectors", "identity", "mfa"],
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
      skipped: ["mfa"],
    });
  });

  it("lands on a named tab when a road asks for it", () => {
    render(<SetupScreen step="identity" onDone={vi.fn()} />);
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
    expect(selectedTab()).toBe("connectors");
    fireEvent.click(screen.getByRole("button", { name: "Previous step" }));
    expect(selectedTab()).toBe("capabilities");
    expect(completeSetup).not.toHaveBeenCalled();
    expect(
      // SAFETY: fixture constructed in this test matches the declared contract.
      (
        screen.getByRole("button", {
          name: "Previous step",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("next advances without calling anything skipped, and stops at the last panel", () => {
    openSetup();
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(selectedTab()).toBe("connectors");
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(selectedTab()).toBe("identity");
    // Browsing is not skipping: the record only hears from Skip and Skip all.
    fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
    expect(completeSetup).toHaveBeenCalledWith({
      ways: ["builtin"],
      service: false,
      skipped: ["identity", "mfa"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "mfa" }));
    expect(screen.queryByRole("button", { name: "Next step" })).toBeNull();
  });

  it("shows only the capabilities tab until a capability registers a panel", () => {
    setupScreenDependencies.useSetupPanels = () => [];
    openSetup();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "capabilities",
    ]);
    expect(screen.queryByRole("button", { name: "Next step" })).toBeNull();
    expect(screen.getByTestId("capability-setup")).toBeTruthy();
  });

  it("orders contributed panels by `order`, then id, and lands on an unknown step at the top", () => {
    render(<SetupScreen step="nothing-like-this" onDone={vi.fn()} />);
    expect(selectedTab()).toBe("capabilities");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "capabilities",
      "connectors",
      "identity",
      "mfa",
    ]);
  });
});
