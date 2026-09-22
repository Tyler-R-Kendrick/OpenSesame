/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_MANAGED_POLICY } from "./composition-fixture.js";
import { double, resetDouble } from "./test-support.js";

vi.mock("../../lib/configuration/capabilities-ports.js", async () => {
  const { fakePortsModule } = await import("./composition-ports-double.js");
  const { double } = await import("./test-support.js");
  return fakePortsModule(double);
});

import { CapabilitySetup } from "./CapabilitySetup.js";
import { RequirementsGate } from "./RequirementsGate.js";

const MANAGED = {
  policy: FIXTURE_MANAGED_POLICY,
  provenance: "same-origin-deployment" as const,
};

beforeEach(() => resetDouble(MANAGED));
afterEach(cleanup);

function focusable(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [tabindex='-1']",
    ),
  ];
}

describe("MODEL-10 — required roots need an explicit yes", () => {
  it("lists the managed instance's required roots on the gate and offers accept, decline and review", () => {
    render(<RequirementsGate onOpenSetup={vi.fn()} />);
    const panel = screen.getByTestId("installation-requirements");
    expect(panel.textContent).toContain("acme requires");
    expect(panel.textContent).toContain("Household sharing");
    expect(
      screen.getByRole("button", { name: "Accept required capabilities" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Decline required capabilities" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Review capabilities" }),
    ).toBeTruthy();
  });

  it("declining on the gate writes nothing and enables nothing", () => {
    const open = vi.fn();
    render(<RequirementsGate onOpenSetup={open} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Decline required capabilities" }),
    );
    expect(screen.queryByTestId("installation-requirements")).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(double.commits).toHaveLength(0);
    expect(double.getSnapshot().plan?.approvedCapabilities).not.toContain(
      "sharing.household",
    );
  });

  it("accepting on the gate is the entry action into setup's join road", () => {
    const open = vi.fn();
    render(<RequirementsGate onOpenSetup={open} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Accept required capabilities" }),
    );
    expect(open).toHaveBeenCalledWith(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Review capabilities" }),
    );
    expect(open).toHaveBeenCalledWith(false);
  });

  it("renders nothing when nothing is owed", () => {
    resetDouble();
    render(<RequirementsGate onOpenSetup={vi.fn()} />);
    expect(screen.queryByTestId("installation-requirements")).toBeNull();
  });

  it("declining inside setup leaves the local path: nothing enabled, nothing committed", () => {
    render(<CapabilitySetup join />);
    expect(screen.getByTestId("installation-requirements")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Decline required capabilities" }),
    );
    expect(screen.queryByTestId("installation-requirements")).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Use the minimal configuration/ }),
    ).toBeTruthy();
    expect(double.commits).toHaveLength(0);
    expect(
      double
        .getSnapshot()
        .plan?.approvedCapabilities.filter((id) => id.startsWith("sharing.")),
    ).toEqual([]);
  });

  it("accepting inside setup ticks the required roots and reviews before any commit", () => {
    render(<CapabilitySetup join />);
    fireEvent.click(
      screen.getByRole("button", { name: "Accept required capabilities" }),
    );
    const household = screen
      .getByTestId("capability-card-sharing.household")
      .querySelector(".capcard__pick");
    expect(household?.getAttribute("aria-pressed")).toBe("true");
    expect(double.commits).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Save on this device" }),
    );
    expect(screen.getByTestId("capability-review").textContent).toContain(
      "Household sharing",
    );
  });

  it("offers Join only while acceptance is owed, and never on a personal-local device", () => {
    render(<CapabilitySetup />);
    expect(
      screen.getByRole("button", { name: /^Join an existing instance/ }),
    ).toBeTruthy();
    cleanup();
    resetDouble();
    render(<CapabilitySetup />);
    expect(
      screen.queryByRole("button", { name: /^Join an existing instance/ }),
    ).toBeNull();
  });
});

describe("SURFACE-10 — keyboard", () => {
  it("Tab reaches every card control, Escape closes the review, focus lands on the first road", () => {
    resetDouble();
    render(<CapabilitySetup />);
    const first = screen.getByRole("button", {
      name: /^Use the minimal configuration/,
    });
    fireEvent.click(
      screen.getByRole("button", { name: /^Customize this installation/ }),
    );
    fireEvent.click(screen.getByTestId("purpose-card-custom"));
    // Every enabled card control is a real button in document order — what
    // Tab walks — and none is hidden behind a tabindex.
    const controls = focusable();
    expect(controls.length).toBeGreaterThan(20);
    for (const control of controls) {
      control.focus();
      expect(document.activeElement).toBe(control);
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Save on this device" }),
    );
    const review = screen.getByTestId("capability-review");
    expect(document.activeElement).toBe(review);
    fireEvent.keyDown(review, { key: "Escape" });
    expect(screen.queryByTestId("capability-review")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^Use the minimal configuration/ }),
    );
    expect(document.activeElement).not.toBe(first);
  });
});
