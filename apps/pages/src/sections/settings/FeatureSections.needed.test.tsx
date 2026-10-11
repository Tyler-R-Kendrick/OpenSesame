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

describe("a switch that could not take is not drawn (ADR 0158)", () => {
  it("says Connections is needed while Git remote backup runs on it, instead of offering a switch that cannot take", () => {
    selecting(["backup.git-remote"]);
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Connections" })).toBeNull();
    expect(
      screen.getByRole("img", { name: "needed by Git remote backup" }),
    ).toBeTruthy();
  });

  it("keeps the switch of a capability with no surface while a persisted selection runs it, so it can always be turned off", () => {
    selecting(["telemetry.external"]);
    renderPanel();
    const telemetry = screen.getByRole("switch", { name: "Telemetry" });
    expect(telemetry.getAttribute("aria-checked")).toBe("true");
    expect(document.getElementById("feature-telemetry")).not.toBeNull();
  });

  it("draws no switch for it once nothing selects it", () => {
    selecting(["agents.webmcp"]);
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Telemetry" })).toBeNull();
    expect(document.getElementById("feature-telemetry")).toBeNull();
  });

  it("offers Connections' switch again once nothing runs on it", () => {
    selecting(["connectors.external"]);
    renderPanel();
    expect(screen.getByRole("switch", { name: "Connections" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: /^needed by/ })).toBeNull();
  });
});
