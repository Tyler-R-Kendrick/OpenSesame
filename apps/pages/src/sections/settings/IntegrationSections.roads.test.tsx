/** @vitest-environment jsdom */
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import {
  connectRoadSeams,
  notifyConnectRoads,
  resetConnectRoadSeams,
} from "@opensesame/app-core/lib/connect-roads.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { identitySeams } from "@opensesame/app-core/lib/identity.js";
import { hasConnectRoute } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { usesConnect } from "@opensesame/app-core/lib/vercel-connect.js";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AI_LABS } from "./AiLabs.js";
import { settingsPageSources } from "./page-tree.js";
import {
  installPanelFixture,
  panelVault,
  renderIntegrationsPanel,
} from "./settings-panels.test-support.js";

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
  it("still lists the main AI labs, without dead links", () => {
    renderIntegrationsPanel();
    expect(tileNames("AI providers")).toEqual(AI_LABS.map((lab) => lab.name));
    expect(screen.queryByRole("link", { name: /OpenAI/ })).toBeNull();
  });

  it("draws no tile that would open a page nothing routes", () => {
    renderIntegrationsPanel();
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
    renderIntegrationsPanel();
    expect(
      screen.getByRole("switch", { name: "GitLab vault history" }),
    ).toBeTruthy();
    const backups = screen.getByRole("list", { name: "Backups providers" });
    expect(backups.querySelectorAll("a")).toHaveLength(0);
  });

  it("does not draw the vault-sealed keys either: their pages are not routed", () => {
    unlockedVault();
    renderIntegrationsPanel();
    expect(screen.queryByText("AWS KMS")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Encryption" })).toBeNull();
  });

  it("is not changed by a Host that is named and granted", () => {
    nameAHostWithALiveGrant();
    renderIntegrationsPanel();
    expect(screen.queryByText("Better Auth")).toBeNull();
    expect(screen.queryByText("1Password")).toBeNull();
  });
});

describe("connector tiles once Connections routes its pages", () => {
  it.each([
    ["replicate", "Replicate"],
    ["stability", "Stability AI"],
    ["deepgram", "Deepgram"],
    ["assemblyai", "AssemblyAI"],
  ])("routes the bundled %s lab through its single shared card", (id, name) => {
    const provider = getBundledProviders().find((row) => row.id === id);
    expect(provider, id).toMatchObject({ category: "ai_model_provider" });
    installConnections();
    renderIntegrationsPanel();
    const labs = within(screen.getByRole("list", { name: "AI providers" }));
    const links = labs.getAllByRole("link", { name });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveProperty("pathname", `/settings/connections/${id}`);
    expect(links[0]?.closest(".conn-tile")).not.toBeNull();
    expect(labs.getAllByRole("listitem")[0]?.textContent).toContain("BYO AI");
  });

  it.each([
    ["AI providers", "BYO AI", "/settings/connections/byo-ai"],
    [
      "Identity providers",
      "BYO Identity",
      "/settings/connections/byo-identity",
    ],
    [
      "Password managers providers",
      "BYO Secret Backend",
      "/settings/connections/byo-secret-backend",
    ],
  ])(
    "puts %s own-service configuration before partner cards",
    (list, name, href) => {
      installConnections();
      renderIntegrationsPanel();
      const first = within(
        screen.getByRole("list", { name: list }),
      ).getAllByRole("listitem")[0];
      if (!first) throw new Error(`Missing first ${list} card`);
      expect(within(first).getByRole("link", { name })).toHaveProperty(
        "pathname",
        href,
      );
    },
  );

  it("keeps the existing partner order after the BYO card", () => {
    installConnections();
    renderIntegrationsPanel();
    expect(tileNames("Identity providers")).toEqual([
      "BYO Identity",
      "Better Auth",
      "Supabase",
      "Neon Auth",
      "Clerk",
      "WorkOS",
      "Auth0",
      "Okta",
    ]);
  });

  it("draws a key or a configuration with no Connect credential", () => {
    installConnections();
    renderIntegrationsPanel();
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
    renderIntegrationsPanel();
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
    renderIntegrationsPanel();
    expect(screen.getByRole("heading", { name: "Encryption" })).toBeTruthy();
    expect(tileNames("Encryption providers")).toEqual(["Azure Key Vault Keys"]);
    for (const title of ["Password managers", "Cloud secret storage"]) {
      expect(screen.getByRole("heading", { name: title }), title).toBeTruthy();
    }
    expect(screen.queryByRole("heading", { name: "Local storage" })).toBeNull();
    for (const name of ["OS Keychain", "KeePass", "S3-compatible bucket"])
      expect(screen.queryByRole("link", { name: new RegExp(name) })).toBeNull();
    // No section here carries a switch: those are Features.
    expect(screen.queryAllByRole("switch")).toHaveLength(
      screen.queryAllByRole("switch", { name: /vault history/ }).length,
    );
  });

  it("draws the vault-sealed keys only for an unlocked vault", () => {
    installConnections();
    unlockedVault();
    renderIntegrationsPanel();
    expect(tileNames("Encryption providers")).toEqual([
      "AWS KMS",
      "Google Cloud KMS",
      "Azure Key Vault Keys",
    ]);
  });

  it("draws the same with a Host named and granted: it opens nothing more", () => {
    installConnections();
    const before = (() => {
      renderIntegrationsPanel();
      return tileNames("Identity providers");
    })();
    nameAHostWithALiveGrant();
    notifyConnectRoads();
    expect(tileNames("Identity providers")).toEqual(before);
  });
});

describe("the rail and the page index list what the page draws", () => {
  const integrations = (empty: readonly string[]) =>
    settingsPageSources({ emptyIntegrations: empty })
      .find((tab) => tab.id === "integrations")
      ?.sections?.map((entry) => entry.label);

  it("leaves out a section that draws nothing", () => {
    expect(integrations([])).toContain("Password managers");
    expect(integrations([])).not.toContain("Local storage");
    const listed = integrations(["password-managers"]);
    expect(listed).not.toContain("Password managers");
    expect(listed).not.toContain("Local storage");
    expect(listed).toContain("Backups");
  });
});
