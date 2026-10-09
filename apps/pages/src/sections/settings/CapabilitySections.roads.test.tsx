/** @vitest-environment jsdom */
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import {
  connectRoadSeams,
  notifyConnectRoads,
  resetConnectRoadSeams,
} from "@opensesame/app-core/lib/connect-roads.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { hasConnectRoute } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { usesConnect } from "@opensesame/app-core/lib/vercel-connect.js";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  installPanelFixture,
  panelVault,
  renderPanel,
} from "./capabilities-panel.test-support.js";
import { settingsPageSources } from "./page-tree.js";

installDoublePorts();

installPanelFixture();

const originalIdentity = { ...identitySeams };

afterEach(() => {
  Object.assign(identitySeams, originalIdentity);
  resetConnectRoadSeams();
});

/** What `connectors.external` installs: Connect's answers, and the pages. */
function installConnections() {
  connectRoadSeams.usesConnect = usesConnect;
  connectRoadSeams.hasConnectRoute = hasConnectRoute;
  connectRoadSeams.pagesOpen = () => true;
  notifyConnectRoads();
}

function nameAHostWithALiveGrant() {
  identitySeams.hostBase = () => "https://host.test";
  identitySeams.hostLocalSessionEligible = () => true;
}

function unlockedVault() {
  // SAFETY: the fixture owns this seam; the panel reads status from the same vault view.
  panelVault.current = {
    tomb: "personal",
    guest: false,
    status: "unlocked",
  } as typeof panelVault.current;
}

function tileNames(list: string): string[] {
  return [
    ...screen
      .getByRole("list", { name: list })
      .querySelectorAll(".conn-tile__name"),
  ].map((node) => node.textContent ?? "");
}

describe("connector tiles while Connections is off", () => {
  it("draws no tile that would open a page nothing routes", () => {
    renderPanel();
    for (const name of [
      "WorkOS",
      "Auth0",
      "Doppler",
      "Better Auth",
      "1Password",
      "Bitwarden",
      "Tailscale",
      "AWS Parameter Store",
    ]) {
      expect(screen.queryByText(name), name).toBeNull();
    }
    expect(screen.queryByText("AWS KMS")).toBeNull();
  });

  it("keeps a history road as its switch, with no link", () => {
    renderPanel();
    expect(
      screen.getByRole("switch", { name: "GitLab vault history" }),
    ).toBeTruthy();
    const backups = screen.getByRole("list", { name: "Backups providers" });
    expect(backups.querySelectorAll("a")).toHaveLength(0);
  });

  it("does not draw the vault-sealed keys either: their pages are not routed", () => {
    unlockedVault();
    renderPanel();
    expect(screen.queryByText("AWS KMS")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Encryption" })).toBeNull();
  });

  it("is not changed by a Host that is named and granted", () => {
    nameAHostWithALiveGrant();
    renderPanel();
    expect(screen.queryByText("Better Auth")).toBeNull();
    expect(screen.queryByText("1Password")).toBeNull();
  });
});

describe("connector tiles once Connections routes its pages", () => {
  it("draws a key or a configuration with no Connect credential", () => {
    installConnections();
    renderPanel();
    for (const name of [
      "WorkOS",
      "Auth0",
      "Doppler",
      "Better Auth",
      "1Password",
      "Bitwarden",
      "Tailscale",
      "AWS Parameter Store",
    ]) {
      expect(screen.getByText(name), name).toBeTruthy();
    }
    // Vault-sealed panels still wait for an unlocked vault.
    expect(screen.queryByText("AWS KMS")).toBeNull();
    expect(screen.queryByText("Google Cloud KMS")).toBeNull();
  });

  it("links them to their pages and keeps Connect's connectors", () => {
    installConnections();
    renderPanel();
    expect(tileNames("Identity providers")).toEqual(
      expect.arrayContaining(["WorkOS", "Auth0", "Better Auth"]),
    );
    expect(tileNames("Cloud secret storage providers")).toContain("Doppler");
    const hrefs = [
      ...screen
        .getByRole("list", { name: "Identity providers" })
        .querySelectorAll("a"),
    ].map((link) => link.getAttribute("href"));
    expect(hrefs).toContain("/settings/connections/better-auth");
  });

  it("leaves out a section that still has nothing to configure", () => {
    installConnections();
    renderPanel();
    expect(screen.queryByRole("heading", { name: "Encryption" })).toBeNull();
    for (const title of [
      "Password managers",
      "Local storage",
      "Cloud secret storage",
    ]) {
      expect(screen.getByRole("heading", { name: title }), title).toBeTruthy();
    }
    // A section with a switch keeps it even with no connector tiles.
    // Household sharing has no surface, so Sharing is not that section here.
    expect(screen.getByRole("switch", { name: "Item types" })).toBeTruthy();
  });

  it("draws the vault-sealed keys only for an unlocked vault", () => {
    installConnections();
    unlockedVault();
    renderPanel();
    expect(tileNames("Encryption providers")).toEqual([
      "AWS KMS",
      "Google Cloud KMS",
    ]);
  });

  it("draws the same with a Host named and granted: it opens nothing more", () => {
    installConnections();
    const before = (() => {
      renderPanel();
      return tileNames("Identity providers");
    })();
    nameAHostWithALiveGrant();
    notifyConnectRoads();
    expect(tileNames("Identity providers")).toEqual(before);
  });
});

describe("the rail and the page index list what the page draws", () => {
  const capabilities = (empty: readonly string[]) =>
    settingsPageSources({ emptyFeatures: empty })
      .find((tab) => tab.id === "capabilities")
      ?.sections?.map((entry) => entry.label);

  it("leaves out a section that draws nothing", () => {
    expect(capabilities([])).toContain("Password managers");
    const listed = capabilities(["password-managers", "local-storage"]);
    expect(listed).not.toContain("Password managers");
    expect(listed).not.toContain("Local storage");
    expect(listed).toContain("Backups");
  });
});
