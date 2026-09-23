import { FIXTURE_MANAGED_POLICY } from "@opensesame/app-core/lib/configuration/doubles/composition-fixture.js";
import {
  double,
  resetDouble,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import {
  guestsAllowed,
  setGuestsAllowed,
} from "@opensesame/app-core/lib/guest-access.js";
/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";

vi.mock(
  "@opensesame/app-core/lib/configuration/capabilities-ports.js",
  async () => {
    const { mockedPorts } = await import(
      "@opensesame/app-core/lib/configuration/doubles/test-support.js"
    );
    return mockedPorts();
  },
);

import {
  CapabilitiesPanel,
  capabilitiesPanelSeams,
} from "./CapabilitiesPanel.js";

function renderPanel() {
  return render(
    <MemoryRouter>
      <CapabilitiesPanel />
    </MemoryRouter>,
  );
}

const realUseVault = vaultHooksSeams.useVault;
const realNow = capabilitiesPanelSeams.now;
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
  capabilitiesPanelSeams.now = realNow;
});
afterEach(() => {
  cleanup();
  capabilitiesPanelSeams.now = realNow;
  vaultHooksSeams.useVault = realUseVault;
});

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
    vault = { tomb: "personal", guest: true };
    renderPanel();
    expect(screen.queryByTestId("instance-capabilities-panel")).toBeNull();
    cleanup();
    vault = { tomb: "project-4f2a", guest: false };
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

describe("features — one switch per way of using the app", () => {
  it("draws the features and no always-on capability as a switch", () => {
    renderPanel();
    const features = screen.getByRole("list", { name: "Features" });
    for (const title of [
      "Guests",
      "AI",
      "Backups",
      "Payments",
      "Servers",
      "Sharing",
      "Networking",
    ]) {
      expect(features.textContent, title).toContain(title);
    }
    expect(screen.queryByRole("switch", { name: "Passwords" })).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Passkey records" }),
    ).toBeNull();
  });

  it("switching a feature on reviews, then commits every capability behind it", async () => {
    renderPanel();
    const sharing = screen.getByRole("switch", { name: "Sharing" });
    expect(sharing.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sharing);
    expect(screen.getByTestId("capability-review")).toBeTruthy();
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() => expect(double.commits).toHaveLength(1));
    const selected = double.commits[0]?.draft.selectedOptional ?? [];
    expect(selected).toContain("sharing.drops");
    expect(selected).toContain("sharing.household");
    // The roots the installation already had are kept.
    expect(selected).toContain("agents.webmcp");
  });

  it("switching a running feature off removes it and keeps the rest", async () => {
    renderPanel();
    const ai = screen.getByRole("switch", { name: "AI" });
    expect(ai.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(ai);
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() => expect(double.commits).toHaveLength(1));
    expect(double.commits[0]?.draft.selectedOptional).not.toContain(
      "agents.webmcp",
    );
  });

  it("configures a feature's providers under it only while it is on", () => {
    renderPanel();
    // Backups is off: its git providers are not drawn.
    expect(
      screen.queryByRole("list", { name: "Backups providers" }),
    ).toBeNull();
    cleanup();
    const selection = {
      ...PERSONAL_SELECTION,
      selectedOptional: ["backup.git-remote", "connectors.external"],
    };
    const exposure: Record<string, string> = {};
    for (const id of double.preview(selection).approvedCapabilities)
      exposure[id] = `sha256:fixture-${id}`;
    resetDouble({
      selection,
      receipt: {
        ...withReceipt(),
        roots: selection.selectedOptional,
        exposure,
      },
    });
    renderPanel();
    const tiles = screen.getByRole("list", { name: "Backups providers" });
    expect(tiles.textContent).toContain("GitHub");
    expect(tiles.textContent).toContain("GitLab");
  });

  it("configures the always-on providers with no switch", () => {
    renderPanel();
    const providers = screen.getByRole("region", { name: "Providers" });
    expect(providers.textContent).toContain("Identity providers");
    expect(providers.textContent).toContain("Password managers");
    // A provider may carry its own enable switch (a backup road); a group
    // never does.
    for (const group of ["Identity providers", "Password managers"]) {
      expect(screen.queryByRole("switch", { name: group })).toBeNull();
    }
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

describe("Allow guests", () => {
  it("is on by default and turns off durably", async () => {
    renderPanel();
    const guests = screen.getByRole("switch", { name: "Allow guests" });
    expect(guests.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(guests);
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Allow guests" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(guestsAllowed()).toBe(false);
    await setGuestsAllowed(true);
  });

  it("is the operator's alone: no guest, project tomb or managed member sees it", () => {
    vault = { tomb: "personal", guest: true };
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Allow guests" })).toBeNull();
    cleanup();
    vault = { tomb: "project-4f2a", guest: false };
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Allow guests" })).toBeNull();
    cleanup();
    vault = { tomb: "personal", guest: false };
    resetDouble({
      policy: FIXTURE_MANAGED_POLICY,
      provenance: "same-origin-deployment",
    });
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Allow guests" })).toBeNull();
  });
});
