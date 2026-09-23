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

  it("a partly-on feature switches off, and its own key completes it", async () => {
    const selection = {
      ...PERSONAL_SELECTION,
      selectedOptional: ["sharing.drops"],
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
    const sharing = screen.getByRole("switch", { name: "Sharing" });
    expect(sharing.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on all of Sharing" }),
    );
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() => expect(double.commits).toHaveLength(1));
    expect(double.commits[0]?.draft.selectedOptional).toContain(
      "sharing.household",
    );
    cleanup();
    resetDouble({
      selection,
      receipt: {
        ...withReceipt(),
        roots: selection.selectedOptional,
        exposure,
      },
    });
    renderPanel();
    fireEvent.click(screen.getByRole("switch", { name: "Sharing" }));
    fireEvent.click(screen.getByTestId("capability-apply"));
    await waitFor(() => expect(double.commits).toHaveLength(1));
    expect(double.commits[0]?.draft.selectedOptional).not.toContain(
      "sharing.drops",
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
