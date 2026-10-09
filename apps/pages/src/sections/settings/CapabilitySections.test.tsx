import {
  FEATURES,
  NO_SURFACE,
  featureOf,
  isSwitchable,
} from "@opensesame/app-core/lib/capabilities/features.js";
/** @vitest-environment jsdom */
import { FIXTURE_MANAGED_POLICY } from "@opensesame/app-core/lib/configuration/doubles/composition-fixture.js";
import {
  double,
  resetDouble,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import {
  guestsAllowed,
  setGuestsAllowed,
} from "@opensesame/app-core/lib/guest-access.js";
import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PERSONAL_SELECTION,
  installPanelFixture,
  panelVault,
  renderPanel,
  withReceipt,
} from "./capabilities-panel.test-support.js";

installDoublePorts();

installPanelFixture();

/**
 * Sections that draw nothing while Connections is off, the default (ADR 0153).
 * Their tiles open connector pages, and those pages are routed only while
 * Connections is on, so a tile would lead nowhere (ADR 0158). Backups keeps
 * its tiles: each is the history switch, which acts without a page. External
 * telemetry, Certificate authority and Household sharing have no Pages code
 * behind them. The first two sections have no switch to draw and are absent.
 * Household sharing shares the Sharing section with live sessions, so that
 * section stays and the household switch does not.
 */
const NOTHING_TO_DO_HERE = new Set([
  "encryption",
  "password-managers",
  "cloud-secret-storage",
  "local-storage",
  "telemetry",
  "certificates",
  // Web Push and Notification routing are an Identity API's; with none named
  // there is nothing to switch and the section is absent (ADR 0162).
  "notifications",
]);

describe("sections — one list, one style, a switch only where something is optional", () => {
  it("lets the first section's subheader stand for the list in a tutorial", () => {
    const { container } = renderPanel();
    const marked = container.querySelectorAll(
      '[data-guide-targets~="settings.connectivity"]',
    );
    expect(marked).toHaveLength(1);
    const first = [...container.querySelectorAll(".capsection")].find(
      (section) => section.id !== "feature-guests",
    );
    expect(marked[0]?.closest(".capsection")).toBe(first);
    expect(marked[0]?.getAttribute("data-guide-targets")).toContain(
      `feature.${first?.id.replace("feature-", "")}`,
    );
  });

  it("draws every section once, as a subheader, never as a card row", () => {
    const { container } = renderPanel();
    const titles = [
      ...container.querySelectorAll(".capsection .capsection__title"),
    ].map((node) => node.textContent);
    expect(titles).toEqual([
      "Guests",
      ...FEATURES.filter((feature) => !NOTHING_TO_DO_HERE.has(feature.id)).map(
        (feature) => feature.title,
      ),
      "Instance policy",
    ]);
    // No second list of capabilities, no card rows, nothing that collapses.
    expect(container.querySelector(".capspanel__row")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(screen.queryByText("Advanced")).toBeNull();
    expect(
      screen.queryByRole("list", { name: "Permitted catalog" }),
    ).toBeNull();
  });

  it("puts the switch on the subheader of a section with optional capabilities, and none on an always-on one", () => {
    const { container } = renderPanel();
    for (const feature of FEATURES) {
      if (NOTHING_TO_DO_HERE.has(feature.id)) continue;
      const head = container.querySelector(
        `#feature-${feature.id} > .capsection__head`,
      );
      expect(head, feature.id).not.toBeNull();
      const switches = head?.querySelectorAll("[role=switch]").length ?? 0;
      const marks = head?.querySelectorAll(".status-mark").length ?? 0;
      if (isSwitchable(feature)) expect(switches + marks, feature.id).toBe(1);
      else expect(switches + marks, feature.id).toBe(0);
    }
    expect(screen.queryByRole("switch", { name: "Passwords" })).toBeNull();
    // Passkeys are an item-type extension. This fixture selects them, so the
    // tile switch is on (ADR 0153).
    expect(
      screen
        .getByRole("switch", { name: "Passkey records" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("draws Local notifications as its own section, and names no service or push", () => {
    const { container } = renderPanel();
    const section = container.querySelector("#feature-local-notifications");
    expect(section).not.toBeNull();
    const head = section?.querySelector(".capsection__head");
    expect(
      (head?.querySelectorAll("[role=switch]").length ?? 0) +
        (head?.querySelectorAll(".status-mark").length ?? 0),
      "one switch, or the mark that says why it has none",
    ).toBe(1);
    expect(section?.textContent).not.toMatch(/push|server|identity api/i);
  });

  it("withdraws Push and Notification routing while no Identity API is named, and draws them when one is", () => {
    saveSettings({ ...loadSettings(), identityApi: "" });
    const none = renderPanel();
    expect(none.container.querySelector("#feature-notifications")).toBeNull();
    expect(screen.queryByText("Push notifications")).toBeNull();
    cleanup();
    saveSettings({
      ...loadSettings(),
      identityApi: "https://identity.example.test",
    });
    const named = renderPanel();
    expect(
      named.container.querySelector("#feature-notifications"),
    ).not.toBeNull();
    expect(screen.getByText("Push notifications")).toBeTruthy();
    saveSettings({ ...loadSettings(), identityApi: "" });
  });

  it("draws no view toggle: the documents are files, not a second view of the page", () => {
    renderPanel();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    for (const name of ["Visual", "Source", "Effective"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("draws no Household sharing switch until a plan approves it", () => {
    renderPanel();
    expect(
      screen.queryByRole("switch", { name: "Household sharing" }),
    ).toBeNull();
    // Live sessions and org-vault relay keep Sharing switchable; household
    // stays NO_SURFACE until a plan names it (ADR 0181).
    const sharingCaps = screen.getByRole("list", {
      name: "Sharing capabilities",
    });
    expect(sharingCaps.textContent).toContain("sharing.live");
    expect(sharingCaps.textContent).toContain("sharing.relay");
    expect(sharingCaps.textContent).not.toContain("sharing.household");
    expect(screen.getByRole("switch", { name: "Sharing" })).toBeTruthy();
  });

  it("switching a section on commits every capability behind it", async () => {
    renderPanel();
    const identity = screen.getByRole("switch", { name: "Identity" });
    expect(identity.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(identity);
    expect(screen.queryByTestId("capability-review")).toBeNull();
    await waitFor(() => expect(double.commits).toHaveLength(1));
    const selected = double.commits[0]?.draft.selectedOptional ?? [];
    expect(selected).toContain("identity.federation");
    expect(selected).toContain("agents.webmcp");
    expect(selected).not.toContain("sharing.household");
  });

  it("switching a running section off removes it and keeps the rest", async () => {
    renderPanel();
    const ai = screen.getByRole("switch", { name: "AI" });
    expect(ai.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(ai);
    expect(screen.queryByTestId("capability-review")).toBeNull();
    await waitFor(() => expect(double.commits).toHaveLength(1));
    expect(double.commits[0]?.draft.selectedOptional).not.toContain(
      "agents.webmcp",
    );
  });

  it("turning Sharing off removes household and does not record drops", async () => {
    const selection = {
      ...PERSONAL_SELECTION,
      selectedOptional: [
        "sharing.household",
        "agents.webmcp",
        "vault.passkey-records",
      ],
      chosenAlternatives: { transport: "sharing.drops" },
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
    expect(
      screen
        .getByRole("switch", { name: "Sharing" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("switch", { name: "Household sharing" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Sharing" }));
    expect(screen.queryByTestId("capability-review")).toBeNull();
    await waitFor(() => expect(double.commits).toHaveLength(1));
    const selected = double.commits[0]?.draft.selectedOptional ?? [];
    expect(selected).not.toContain("sharing.household");
    expect(selected).not.toContain("sharing.drops");
    expect(selected).toContain("agents.webmcp");
  });

  it("a one-capability section's subheader switch answers to that capability's title", () => {
    renderPanel();
    const connections = screen.getByRole("switch", { name: "Connections" });
    expect(connections.getAttribute("data-capability-title")).toBe(
      "External connectors",
    );
  });

  it("draws no switch for a capability with no Pages code behind it, though it stays in the catalog for a policy to name", () => {
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Telemetry" })).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Certificate authority" }),
    ).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Household sharing" }),
    ).toBeNull();
    expect(document.getElementById("feature-telemetry")).toBeNull();
    expect(document.getElementById("feature-certificates")).toBeNull();
    // Sharing stays: live sessions are the section's surface.
    expect(document.getElementById("feature-sharing")).not.toBeNull();
    for (const id of NO_SURFACE) expect(featureOf(id), id).not.toBeNull();
  });

  it("draws a section's backup tiles whether or not anything is switched on", () => {
    renderPanel();
    const tiles = screen.getByRole("list", { name: "Backups providers" });
    expect(tiles.textContent).toContain("GitHub");
    expect(tiles.textContent).toContain("GitLab");
    // password-store is a git history road: it is a Backups tile, and Local
    // storage no longer draws it a second time.
    expect(tiles.textContent).toContain("password-store");
    expect(
      screen.queryByRole("list", { name: "Local storage providers" }),
    ).toBeNull();
    for (const group of ["Identity providers", "Password managers"]) {
      expect(screen.queryByRole("switch", { name: group })).toBeNull();
    }
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

  it("turning it off is the operator's alone: no guest, project tomb or managed member sees it", () => {
    panelVault.current = { tomb: "personal", guest: true };
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Allow guests" })).toBeNull();
    cleanup();
    panelVault.current = { tomb: "project-4f2a", guest: false };
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Allow guests" })).toBeNull();
    cleanup();
    panelVault.current = { tomb: "personal", guest: false };
    resetDouble({
      policy: FIXTURE_MANAGED_POLICY,
      provenance: "same-origin-deployment",
    });
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Allow guests" })).toBeNull();
  });

  it("once off, anyone signed in here may turn it back on — never a guest", async () => {
    await setGuestsAllowed(false);
    panelVault.current = { tomb: "project-4f2a", guest: false };
    renderPanel();
    const guests = screen.getByRole("switch", { name: "Allow guests" });
    expect(guests.getAttribute("aria-checked")).toBe("false");
    cleanup();
    panelVault.current = { tomb: "personal", guest: true };
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Allow guests" })).toBeNull();
    await setGuestsAllowed(true);
  });
});
