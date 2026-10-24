/** @vitest-environment jsdom */
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { sectionCategory } from "./FeatureSections.js";
import {
  installPanelFixture,
  renderFeatureConfig,
  renderPanel,
} from "./settings-panels.test-support.js";

installDoublePorts();
installPanelFixture();

let revoke: (() => void) | null = null;

afterEach(() => {
  revoke?.();
  revoke = null;
  cleanup();
});

describe("a feature's own page", () => {
  it("keeps the relay panel off the list and opens it for Vault relay", () => {
    revoke = registerContributionForTest("settings-panel", {
      id: "org-vault-directory",
      label: "Organization vaults",
      category: sectionCategory("feature-sharing"),
      Panel: () => <div>Relay directory settings</div>,
      order: 40,
    });

    renderPanel();
    expect(screen.queryByText("Relay directory settings")).toBeNull();
    const relay = screen.getByRole("link", { name: "sharing.relay" });
    expect(relay.getAttribute("href")).toBe(
      "/settings/features/sharing/sharing.relay",
    );
    cleanup();

    renderFeatureConfig("sharing", "sharing.relay");
    expect(screen.getByText("Relay directory settings")).toBeTruthy();
  });

  it("opens Networking with its tailnet sync panel", () => {
    revoke = registerContributionForTest("settings-panel", {
      id: "tailnet-sync",
      label: "Tailnet sync",
      category: sectionCategory("feature-networking"),
      Panel: () => <div>Tailnet sync settings</div>,
      order: 10,
    });
    renderFeatureConfig("networking", "networking.tailnet");
    expect(screen.getByText("Tailnet sync settings")).toBeTruthy();
  });

  it("refuses a no-surface capability from a direct URL", () => {
    renderFeatureConfig("telemetry", "telemetry.external");
    expect(screen.getByText("Feature not found")).toBeTruthy();
  });

  it("opens Trusted contacts with its directory panel", () => {
    revoke = registerContributionForTest("settings-panel", {
      id: "trusted-contacts",
      label: "Trusted contacts",
      category: "security",
      Panel: () => <div>Trusted contacts directory</div>,
      order: 330,
    });
    renderFeatureConfig("sharing", "sharing.trusted-contacts");
    expect(screen.getByText("Trusted contacts directory")).toBeTruthy();
  });

  it("does not give another sharing row the relay's panel", () => {
    revoke = registerContributionForTest("settings-panel", {
      id: "org-vault-directory",
      label: "Organization vaults",
      category: sectionCategory("feature-sharing"),
      Panel: () => <div>Relay directory settings</div>,
      order: 40,
    });
    renderFeatureConfig("sharing", "sharing.live");
    expect(screen.queryByText("Relay directory settings")).toBeNull();
  });
});
