/** @vitest-environment jsdom */
import { INTEGRATIONS } from "@opensesame/app-core/lib/capabilities/integrations.js";
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import {
  connectRoadSeams,
  connectorTile,
  notifyConnectRoads,
} from "@opensesame/app-core/lib/connect-roads.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { hasConnectRoute } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { integrationDraws, providerTileItems } from "./provider-tile-items.js";
import {
  installPanelFixture,
  openConnectorPages,
  renderIntegrationsPanel,
} from "./settings-panels.test-support.js";

installDoublePorts();

installPanelFixture();

describe("Integrations — one list, one style, no switch", () => {
  it("lets the first section's subheader stand for the list in a tutorial", () => {
    openConnectorPages();
    const { container } = renderIntegrationsPanel();
    const marked = container.querySelectorAll(
      '[data-guide-targets~="settings.integrations-list"]',
    );
    expect(marked).toHaveLength(1);
    const first = container.querySelector(".capsection");
    expect(marked[0]?.closest(".capsection")).toBe(first);
    expect(marked[0]?.getAttribute("data-guide-targets")).toContain(
      `integration.${first?.id.replace("integration-", "")}`,
    );
  });

  it("draws a section only for a connector that has something to do, never a card row", () => {
    openConnectorPages();
    const { container } = renderIntegrationsPanel();
    const titles = [
      ...container.querySelectorAll(".capsection .capsection__title"),
    ].map((node) => node.textContent);
    expect(titles.length).toBeGreaterThan(0);
    const known = new Set(INTEGRATIONS.map((entry) => entry.title));
    for (const title of titles) expect(known.has(title ?? "")).toBe(true);
    expect(new Set(titles).size).toBe(titles.length);
    expect(container.querySelector(".capspanel__row")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
  });

  it("keeps the section ids apart from Features' (integration-<id>)", () => {
    openConnectorPages();
    const { container } = renderIntegrationsPanel();
    for (const section of container.querySelectorAll(".capsection")) {
      expect(section.id).toMatch(/^integration-/);
    }
  });

  it("draws a section's backup tiles whether or not anything is switched on", () => {
    renderIntegrationsPanel();
    const tiles = screen.getByRole("list", { name: "Backups providers" });
    expect(tiles.textContent).toContain("GitHub");
    expect(tiles.textContent).toContain("GitLab");
    // password-store is a git history road: it is a Backups tile, and Local
    // storage no longer draws it a second time.
    expect(tiles.textContent).toContain("password-store");
    expect(
      screen.queryByRole("list", { name: "Local storage providers" }),
    ).toBeNull();
  });

  it("is not a place to switch a feature: only a history road wears a switch", () => {
    openConnectorPages();
    renderIntegrationsPanel();
    for (const name of [
      "Identity",
      "AI",
      "Payments",
      "Networking",
      "Allow guests",
    ]) {
      expect(screen.queryByRole("switch", { name }), name).toBeNull();
    }
  });
});

describe("Services uses the shared provider cards and current connector roads", () => {
  it("shows actual bundled Linear and Vercel in Services without managed authorization", () => {
    connectRoadSeams.hasConnectRoute = hasConnectRoute;
    openConnectorPages();
    renderIntegrationsPanel();
    const services = screen.getByRole("region", { name: "Services" });
    const cards = within(services);
    expect(
      cards.getByRole("link", { name: /Linear/ }).getAttribute("href"),
    ).toBe("/settings/connections/linear");
    expect(
      cards.getByRole("link", { name: /Vercel/ }).getAttribute("href"),
    ).toBe("/settings/connections/vercel");
    expect(connectRoadSeams.usesConnect("linear")).toBe(false);
    expect(cards.getAllByRole("listitem")).toHaveLength(2);
    expect(cards.queryByRole("switch")).toBeNull();
    expect(cards.queryByRole("link", { name: /Microsoft|Slack/ })).toBeNull();
    expect(
      cards
        .getAllByRole("list")
        .every((list) => list.classList.contains("conn-grid")),
    ).toBe(true);
    expect(
      services.querySelector('[data-guide-targets~="integration.services"]'),
    ).not.toBeNull();
    expect(
      screen.queryByRole("list", { name: "Local storage providers" }),
    ).toBeNull();
  });

  it("reacts to route withdrawal instead of leaving a dead provider link or Services heading", () => {
    connectRoadSeams.hasConnectRoute = hasConnectRoute;
    renderIntegrationsPanel();
    expect(screen.queryByRole("region", { name: "Services" })).toBeNull();
    act(() => openConnectorPages());
    expect(screen.getByRole("link", { name: /Linear/ })).toBeTruthy();
    act(() => {
      connectRoadSeams.hasConnectRoute = () => false;
      notifyConnectRoads();
    });
    expect(screen.queryByRole("link", { name: /Linear/ })).toBeNull();
    act(() => {
      connectRoadSeams.pagesOpen = () => false;
      notifyConnectRoads();
    });
    expect(screen.queryByRole("region", { name: "Services" })).toBeNull();
    expect(
      screen.getByRole("switch", { name: "GitLab vault history" }),
    ).toBeTruthy();
  });
});

const currentRoad = (provider: Parameters<typeof connectorTile>[0]) =>
  connectorTile(provider, false);

function openCurrentRoutes(): void {
  connectRoadSeams.pagesOpen = () => true;
  connectRoadSeams.hasConnectRoute = hasConnectRoute;
}

describe("bundled provider card admission", () => {
  it("offers Linear and Vercel through their actual current road without a Connect credential", () => {
    openCurrentRoutes();
    expect(connectRoadSeams.usesConnect("linear")).toBe(false);
    expect(hasConnectRoute("linear")).toBe(true);
    expect(providerTileItems("productivity", currentRoad)).toMatchObject([
      { provider: { id: "linear" }, href: "/settings/connections/linear" },
    ]);
    expect(providerTileItems("developer", currentRoad)).toMatchObject([
      { provider: { id: "vercel" }, href: "/settings/connections/vercel" },
    ]);
  });

  it("keeps routed page availability as authority, including managed rows", () => {
    expect(providerTileItems("productivity", currentRoad)).toEqual([]);
    expect(providerTileItems("developer", currentRoad)).toEqual([]);
    openCurrentRoutes();
    connectRoadSeams.hasConnectRoute = () => false;
    expect(providerTileItems("productivity", currentRoad)).toEqual([]);
    connectRoadSeams.hasConnectRoute = hasConnectRoute;
    expect(providerTileItems("productivity", currentRoad)).toHaveLength(1);
    connectRoadSeams.pagesOpen = () => false;
    expect(providerTileItems("productivity", currentRoad)).toEqual([]);
    expect(currentRoad({ id: "unknown-provider" })).toBeNull();
  });

  it("asks the original callback about Linear and excludes declined or unbundled rows", () => {
    const seen: string[] = [];
    expect(
      providerTileItems("productivity", (provider) => {
        seen.push(provider.id);
        return null;
      }),
    ).toEqual([]);
    expect(seen).toEqual(["linear"]);
    expect(catalogProvider("microsoft")?.category).toBe("productivity");
    expect(seen).not.toContain("microsoft");
    expect(providerTileItems("custom", () => "page")).toEqual([]);
    expect(providerTileItems("testing", () => "page")).toEqual([]);
    expect(providerTileItems("local_storage", () => "page")).toEqual([]);
  });

  it("retains linkless history roads while connector pages are closed", () => {
    const items = providerTileItems("backup_recovery", currentRoad);
    expect(items.some(({ provider }) => provider.id === "gitlab")).toBe(true);
    expect(items.every(({ href }) => href === null)).toBe(true);
    expect(providerTileItems("password_managers", currentRoad)).toEqual([]);
  });

  it("preserves BYO-first ordering across every section's existing categories", () => {
    for (const integration of INTEGRATIONS) {
      for (const category of integration.providerCategories) {
        const ids = providerTileItems(category, () => "page").map(
          ({ provider }) => provider.id,
        );
        const byo = ids.filter((id) => id.startsWith("byo-"));
        expect(ids.slice(0, byo.length), category).toEqual(byo);
      }
    }
    expect(providerTileItems("identity", () => "page")[0]?.provider.id).toBe(
      "byo-identity",
    );
  });

  it("draws Services only when an existing bundled provider has a road", () => {
    const services = INTEGRATIONS.find((entry) => entry.id === "services");
    expect(services).toBeDefined();
    if (!services) throw new Error("Missing Services integration");
    expect(integrationDraws(services, currentRoad)).toBe(false);
    openCurrentRoutes();
    expect(integrationDraws(services, currentRoad)).toBe(true);
    expect(integrationDraws(services, () => null)).toBe(false);
  });
});
