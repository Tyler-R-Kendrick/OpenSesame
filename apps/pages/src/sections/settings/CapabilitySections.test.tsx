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
import {
  guestsAllowed,
  setGuestsAllowed,
} from "@opensesame/app-core/lib/guest-access.js";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  PERSONAL_SELECTION,
  installPanelFixture,
  panelVault,
  renderPanel,
  withReceipt,
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

describe("sections — one list, one style, a switch only where something is optional", () => {
  it("draws every section once, as a subheader, never as a card row", () => {
    const { container } = renderPanel();
    const titles = [
      ...container.querySelectorAll(".capsection .capsection__title"),
    ].map((node) => node.textContent);
    expect(titles).toEqual([
      "Guests",
      ...FEATURES.map((feature) => feature.title),
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
    expect(
      screen.queryByRole("switch", { name: "Passkey records" }),
    ).toBeNull();
  });

  it("draws one Page toggle: the instance policy has no second one", () => {
    renderPanel();
    expect(
      screen.getAllByRole("radiogroup", { name: "Capability view" }),
    ).toHaveLength(1);
  });

  it("switching a section on reviews, then commits every capability behind it", async () => {
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

  it("switching a running section off removes it and keeps the rest", async () => {
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

  it("a partly-on section is completed from its tiles, and its switch turns it off", async () => {
    const selection = {
      ...PERSONAL_SELECTION,
      selectedOptional: ["sharing.drops"],
    };
    const exposure: Record<string, string> = {};
    for (const id of double.preview(selection).approvedCapabilities)
      exposure[id] = `sha256:fixture-${id}`;
    const partly = () =>
      resetDouble({
        selection,
        receipt: {
          ...withReceipt(),
          roots: selection.selectedOptional,
          exposure,
        },
      });
    partly();
    renderPanel();
    expect(
      screen
        .getByRole("switch", { name: "Sharing" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const household = screen.getByRole("switch", { name: "Household sharing" });
    expect(household.getAttribute("aria-checked")).toBe("false");
    expect(household.getAttribute("data-capability-title")).toBe(
      "Household sharing",
    );
    fireEvent.click(household);
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() => expect(double.commits).toHaveLength(1));
    expect(double.commits[0]?.draft.selectedOptional).toContain(
      "sharing.household",
    );
    cleanup();
    partly();
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Sharing" }));
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() => expect(double.commits).toHaveLength(1));
    expect(double.commits[0]?.draft.selectedOptional).not.toContain(
      "sharing.drops",
    );
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
    expect(
      screen.getByRole("list", { name: "Local storage providers" }).textContent,
    ).not.toContain("password-store");
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
