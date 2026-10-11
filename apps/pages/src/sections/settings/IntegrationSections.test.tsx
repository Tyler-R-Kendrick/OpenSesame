/** @vitest-environment jsdom */
import { INTEGRATIONS } from "@opensesame/app-core/lib/capabilities/integrations.js";
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
