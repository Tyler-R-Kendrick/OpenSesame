/** @vitest-environment jsdom */
import { FIXTURE_MANAGED_POLICY } from "@opensesame/app-core/lib/configuration/doubles/composition-fixture.js";
import {
  double,
  resetDouble,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { capabilitiesPanelSeams } from "./CapabilitiesPanel.js";
import {
  PERSONAL_SELECTION,
  installPanelFixture,
  panelVault,
  renderPanel,
} from "./capabilities-panel.test-support.js";

vi.mock(
  "@opensesame/app-core/lib/configuration/capabilities-ports.js",
  async () => {
    const { mockedPorts } = await import(
      "@opensesame/app-core/lib/configuration/doubles/test-support.js"
    );
    return mockedPorts();
  },
);

installPanelFixture();

describe("Advanced — one row per optional capability", () => {
  it("shows each optional capability with its lifecycle, and actions only on running ones", () => {
    renderPanel();
    const panel = screen.getByTestId("capabilities-panel");
    expect(panel.textContent).toContain("Agent tools (WebMCP)");
    expect(panel.textContent).toContain("active");
    expect(
      screen.getByRole("button", { name: "Disable Agent tools (WebMCP) now" }),
    ).toBeTruthy();
    // Always-on capabilities are not configurations: no row at all.
    expect(
      screen.getByRole("list", { name: "Optional capabilities" }).textContent,
    ).not.toContain("Passwords");
    expect(
      screen.queryByRole("button", { name: "Disable Shared drops now" }),
    ).toBeNull();
  });

  it("Disable now goes straight to the store's emergency disable", async () => {
    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "Disable Agent tools (WebMCP) now" }),
    );
    await waitFor(() => expect(double.disabled).toEqual(["agents.webmcp"]));
    expect(double.commits).toHaveLength(0);
  });

  it("Retire safely reviews, then commits with the root removed", async () => {
    renderPanel();
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
    renderPanel();
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

  it("gives every commit its own revision, even when the clock does not move", async () => {
    // The wall clock is not a source of uniqueness. A browser clamps
    // `Date.now()` for Spectre, a test harness freezes it outright, and two
    // commits inside one tick then carry the same revision — which the
    // commit preflight rightly reads as a conflict (CONSENT-08), refusing
    // the second with `selection-revision`. That is how a person who had
    // chosen one capability could never choose a second.
    capabilitiesPanelSeams.now = () => "2026-09-10T00:00:00.000Z";
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Add Shared drops" }));
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() => expect(double.commits).toHaveLength(1));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Retire Agent tools (WebMCP) safely",
      }),
    );
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() => expect(double.commits).toHaveLength(2));
    expect(double.commits[1]?.draft.revision).not.toEqual(
      double.commits[0]?.draft.revision,
    );
    expect(double.commits[1]?.receipt.selectionRevision).toEqual(
      double.commits[1]?.draft.revision,
    );
  });

  it("offers no way in for a capability already running, or one this distribution lacks", () => {
    renderPanel();
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
    renderPanel();
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
    renderPanel();
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
    renderPanel();
    expect(screen.getByTestId("instance-capabilities-panel")).toBeTruthy();
    expect(screen.getByTestId("purpose-card-personal")).toBeTruthy();
  });

  it("hides it from a guest and from any other tomb", () => {
    panelVault.current = { tomb: "personal", guest: true };
    renderPanel();
    expect(screen.queryByTestId("instance-capabilities-panel")).toBeNull();
    cleanup();
    panelVault.current = { tomb: "project-4f2a", guest: false };
    renderPanel();
    expect(screen.queryByTestId("instance-capabilities-panel")).toBeNull();
  });

  it("hides it from a member of a managed instance", () => {
    resetDouble({
      policy: FIXTURE_MANAGED_POLICY,
      provenance: "same-origin-deployment",
    });
    renderPanel();
    expect(screen.queryByTestId("instance-capabilities-panel")).toBeNull();
    expect(screen.queryByTestId("purpose-card-personal")).toBeNull();
    expect(screen.queryByRole("button", { name: /Personal/ })).toBeNull();
  });
});

describe("Advanced", () => {
  it("stays open across a review, so the row just changed is still in view", async () => {
    renderPanel();
    const details = () =>
      screen.getByTestId("capabilities-advanced") as HTMLDetailsElement;
    expect(details().open).toBe(false);
    details().open = true;
    fireEvent(details(), new Event("toggle"));
    fireEvent.click(screen.getByRole("button", { name: "Add Shared drops" }));
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() => expect(double.commits).toHaveLength(1));
    expect(details().open).toBe(true);
    // And when the plan change remounts the panel.
    cleanup();
    renderPanel();
    expect(details().open).toBe(true);
    details().open = false;
    fireEvent(details(), new Event("toggle"));
  });
});
