/** @vitest-environment jsdom */
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
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
});

function openHostRoad() {
  identitySeams.hostBase = () => "https://host.test";
  identitySeams.hostLocalSessionEligible = () => true;
}

function unlockedVault() {
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

describe("connector tiles on a device with no Host", () => {
  it("draw only the connectors whose page has something to do", () => {
    renderPanel();
    expect(tileNames("Identity providers")).toEqual(["WorkOS", "Auth0"]);
    expect(tileNames("Cloud secret storage providers")).toEqual(["Doppler"]);
    // Every one of these saves through a Host, and none can act here.
    for (const gone of [
      "Better Auth",
      "1Password",
      "Bitwarden",
      "Tailscale",
      "AWS Parameter Store",
    ]) {
      expect(screen.queryByText(gone), gone).toBeNull();
    }
  });

  it("leave out the section that has nothing left, rather than a subheader over nothing", () => {
    renderPanel();
    for (const title of ["Password managers", "Local storage", "Encryption"]) {
      expect(screen.queryByRole("heading", { name: title }), title).toBeNull();
    }
    // A section with a switch keeps it even with no connector tiles.
    expect(screen.getByRole("switch", { name: "Sharing" })).toBeTruthy();
  });

  it("draw the vault-sealed keys only for an unlocked vault", () => {
    unlockedVault();
    renderPanel();
    expect(tileNames("Encryption providers")).toEqual([
      "AWS KMS",
      "Google Cloud KMS",
    ]);
  });

  it("come back, sections and all, once a Host is open", () => {
    openHostRoad();
    renderPanel();
    expect(tileNames("Identity providers")).toContain("Better Auth");
    expect(
      screen.getByRole("heading", { name: "Password managers" }),
    ).toBeTruthy();
    expect(tileNames("Password managers providers")).toContain("1Password");
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
