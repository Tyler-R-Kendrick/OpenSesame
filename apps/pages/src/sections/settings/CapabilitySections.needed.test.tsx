/** @vitest-environment jsdom */
import {
  double,
  installDoublePorts,
  resetDouble,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import type { InstallationCapabilitySelection } from "@opensesame/capability-composition";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PERSONAL_SELECTION,
  installPanelFixture,
  renderPanel,
  withReceipt,
} from "./capabilities-panel.test-support.js";

installDoublePorts();
installPanelFixture();

afterEach(cleanup);

function selecting(selectedOptional: string[]) {
  const selection: InstallationCapabilitySelection = {
    ...PERSONAL_SELECTION,
    selectedOptional,
    chosenAlternatives: {},
  };
  const exposure: Record<string, string> = {};
  for (const id of double.preview(selection).approvedCapabilities)
    exposure[id] = `sha256:fixture-${id}`;
  resetDouble({
    selection,
    receipt: { ...withReceipt(), roots: selectedOptional, exposure },
  });
}

describe("a switch that could not take is not drawn (ADR 0158 §3)", () => {
  it("says Connections is needed while Git remote backup runs on it, instead of offering a switch that cannot take", () => {
    selecting(["backup.git-remote"]);
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Connections" })).toBeNull();
    expect(
      screen.getByRole("img", { name: "needed by Git remote backup" }),
    ).toBeTruthy();
  });

  it("draws no connector tile while Connections is off: its pages are Connections' routes, so a tile is a link to a blank page", () => {
    selecting(["agents.webmcp"]);
    renderPanel();
    expect(screen.queryByRole("list", { name: "AI providers" })).toBeNull();
    expect(
      screen.queryByRole("list", { name: "Backups providers" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: /Anthropic/ })).toBeNull();
    expect(
      document.querySelector("a[href*='/settings/connections/']"),
    ).toBeNull();
    // The sections' own switches are still there to turn on.
    expect(screen.getByRole("switch", { name: "Connections" })).toBeTruthy();
  });

  it("draws the tiles once Connections runs", () => {
    selecting(["agents.webmcp", "connectors.external"]);
    double.setActive("connectors.external");
    renderPanel();
    expect(screen.getByRole("list", { name: "AI providers" })).toBeTruthy();
  });

  it("offers Connections' switch again once nothing runs on it", () => {
    selecting(["connectors.external"]);
    renderPanel();
    expect(screen.getByRole("switch", { name: "Connections" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /^needed by/ })).toBeNull();
  });
});
