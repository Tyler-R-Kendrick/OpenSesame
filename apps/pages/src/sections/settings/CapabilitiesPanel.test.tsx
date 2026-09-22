/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { FIXTURE_MANAGED_POLICY } from "../../screens/capabilities/composition-fixture.js";
import {
  double,
  resetDouble,
} from "../../screens/capabilities/test-support.js";

vi.mock("../../lib/configuration/capabilities-ports.js", async () => {
  const { fakePortsModule } = await import(
    "../../screens/capabilities/composition-ports-double.js"
  );
  const { double } = await import("../../screens/capabilities/test-support.js");
  return fakePortsModule(double);
});

import {
  CapabilitiesPanel,
  capabilitiesPanelSeams,
} from "./CapabilitiesPanel.js";

const realUseVault = vaultHooksSeams.useVault;
let vault = { tomb: "personal", guest: false };

const PERSONAL_SELECTION = {
  schemaVersion: 1 as const,
  kind: "InstallationCapabilitySelection" as const,
  instanceId: "personal-local",
  installationId: "inst-1",
  basePolicyRevision: "0",
  revision: "1",
  acceptedRequired: [],
  selectedOptional: ["agents.webmcp", "vault.passkey-records"],
  chosenAlternatives: {},
  delivery: { prefetch: "none" as const, offlineCache: "shell-only" as const },
};

function withReceipt() {
  const plan = double.preview(PERSONAL_SELECTION);
  const exposure: Record<string, string> = {};
  for (const id of plan.approvedCapabilities)
    exposure[id] = `sha256:fixture-${id}`;
  return {
    schemaVersion: 1 as const,
    instanceId: "personal-local",
    installationId: "inst-1",
    policyRevision: "0",
    selectionRevision: "1",
    acceptedAt: "2026-09-22T00:00:00Z",
    roots: ["agents.webmcp", "vault.passkey-records"],
    exposure,
    receiptDigest: "sha256:r",
  };
}

beforeEach(() => {
  vault = { tomb: "personal", guest: false };
  vaultHooksSeams.useVault = () => ({ ...realUseVault(), ...vault });
  resetDouble({ selection: PERSONAL_SELECTION, receipt: withReceipt() });
  double.setActive("agents.webmcp");
  capabilitiesPanelSeams.reload = vi.fn();
});
afterEach(() => {
  cleanup();
  vaultHooksSeams.useVault = realUseVault;
});

describe("what this device uses", () => {
  it("shows one row per capability with its lifecycle, and actions only on running ones", () => {
    render(<CapabilitiesPanel />);
    const panel = screen.getByTestId("capabilities-panel");
    expect(panel.textContent).toContain("Agent tools (WebMCP)");
    expect(panel.textContent).toContain("active");
    expect(
      screen.getByRole("button", { name: "Disable Agent tools (WebMCP) now" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Disable Passwords now" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Disable Shared drops now" }),
    ).toBeNull();
  });

  it("Disable now goes straight to the store's emergency disable", async () => {
    render(<CapabilitiesPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Disable Agent tools (WebMCP) now" }),
    );
    await waitFor(() => expect(double.disabled).toEqual(["agents.webmcp"]));
    expect(double.commits).toHaveLength(0);
  });

  it("Retire safely reviews, then commits with the root removed", async () => {
    render(<CapabilitiesPanel />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Retire Agent tools (WebMCP) safely",
      }),
    );
    expect(screen.getByTestId("capability-review").textContent).toContain(
      "Agent tools (WebMCP)",
    );
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() => expect(double.commits).toHaveLength(1));
    expect(double.commits[0]?.draft.selectedOptional).toEqual([
      "vault.passkey-records",
    ]);
    expect(double.disabled).toHaveLength(0);
  });

  it("Add reviews, then commits with the root added — a choice is not one-way", async () => {
    render(<CapabilitiesPanel />);
    // Not running here, and this installation may have it: the row offers a
    // way in. Before this, setup was the only place to choose, and setup
    // lives before sign-in.
    fireEvent.click(screen.getByRole("button", { name: "Add Shared drops" }));
    expect(screen.getByTestId("capability-review").textContent).toContain(
      "Shared drops",
    );
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() => expect(double.commits).toHaveLength(1));
    expect(double.commits[0]?.draft.selectedOptional).toContain(
      "sharing.drops",
    );
    // Adding is not disabling: nothing was force-stopped on the way.
    expect(double.disabled).toHaveLength(0);
  });

  it("offers no way in for a capability already running, or one this distribution lacks", () => {
    render(<CapabilitiesPanel />);
    expect(
      screen.queryByRole("button", { name: "Add Agent tools (WebMCP)" }),
    ).toBeNull();
  });

  it("says a reload is owed while an unloaded module is still evaluated here", () => {
    resetDouble({
      selection: {
        ...PERSONAL_SELECTION,
        selectedOptional: ["vault.passkey-records"],
      },
      evaluatedModuleIds: ["agents.webmcp/runtime"],
    });
    render(<CapabilitiesPanel />);
    expect(screen.getByTestId("capabilities-restart").textContent).toContain(
      "reload",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));
    expect(capabilitiesPanelSeams.reload).toHaveBeenCalled();
    expect(screen.getByTestId("capabilities-panel").textContent).toContain(
      "restart required",
    );
  });

  it("switches Visual / Source / Effective", () => {
    render(<CapabilitiesPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Effective" })[0]);
    expect(screen.getByLabelText("Effective plan").textContent).toContain(
      "approvedCapabilities",
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Source" })[0]);
    expect(
      screen.getByTestId("capability-source-installation-selection"),
    ).toBeTruthy();
  });
});

describe("SURFACE-06 — a member never sees policy controls", () => {
  it("shows the instance policy only to the operator of a personal-local device in the personal tomb", () => {
    render(<CapabilitiesPanel />);
    expect(screen.getByTestId("instance-capabilities-panel")).toBeTruthy();
    expect(screen.getByTestId("purpose-card-personal")).toBeTruthy();
  });

  it("hides it from a guest and from any other tomb", () => {
    vault = { tomb: "personal", guest: true };
    render(<CapabilitiesPanel />);
    expect(screen.queryByTestId("instance-capabilities-panel")).toBeNull();
    cleanup();
    vault = { tomb: "project-4f2a", guest: false };
    render(<CapabilitiesPanel />);
    expect(screen.queryByTestId("instance-capabilities-panel")).toBeNull();
  });

  it("hides it from a member of a managed instance", () => {
    resetDouble({
      policy: FIXTURE_MANAGED_POLICY,
      provenance: "same-origin-deployment",
    });
    render(<CapabilitiesPanel />);
    expect(screen.queryByTestId("instance-capabilities-panel")).toBeNull();
    expect(screen.queryByTestId("purpose-card-personal")).toBeNull();
    expect(screen.queryByRole("button", { name: /Personal/ })).toBeNull();
  });
});
