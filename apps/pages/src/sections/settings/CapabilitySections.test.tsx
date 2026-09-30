import {
  FEATURES,
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
 * Sections that draw nothing on a device with no Host, no Connect credential
 * and no unlocked vault. Encryption's panels seal a key in the vault, so a
 * locked vault draws no tile and no switch (ADR 0150). A key or a
 * configuration seals on this device, so those sections stay.
 */
const NOTHING_TO_DO_HERE = new Set(["encryption"]);

describe("sections — one list, one style, a switch only where something is optional", () => {
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

  it("draws no view toggle: the documents are files, not a second view of the page", () => {
    renderPanel();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    for (const name of ["Visual", "Source", "Effective"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("switching a section on reviews, then commits every capability behind it", async () => {
    renderPanel();
    const sharing = screen.getByRole("switch", { name: "Sharing" });
    expect(sharing.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sharing);
    expect(screen.queryByTestId("capability-review")).toBeNull();
    expect(screen.getByRole("list", { name: "Sharing capabilities" })).toBeTruthy();
    await waitFor(() => expect(double.commits).toHaveLength(1));
    const selected = double.commits[0]?.draft.selectedOptional ?? [];
    // Drops are always on, so the switch does not record them. Live
    // sessions are not in this fixture's distribution, so only household
    // sharing is added.
    expect(selected).not.toContain("sharing.drops");
    expect(selected).toContain("sharing.household");
    expect(selected).toContain("agents.webmcp");
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
    const telemetry = screen.getByRole("switch", { name: "Telemetry" });
    expect(telemetry.getAttribute("data-capability-title")).toBe(
      "External telemetry",
    );
  });

  it("draws a section's providers whether or not anything is switched on", () => {
    renderPanel();
    const tiles = screen.getByRole("list", { name: "Backups providers" });
    expect(tiles.textContent).toContain("GitHub");
    expect(tiles.textContent).toContain("GitLab");
    // password-store is a git history road: it is a Backups tile, and Local
    // storage no longer draws it a second time.
    expect(tiles.textContent).toContain("password-store");
    const local = screen.getByRole("list", { name: "Local storage providers" });
    expect(local.textContent).not.toContain("password-store");
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
