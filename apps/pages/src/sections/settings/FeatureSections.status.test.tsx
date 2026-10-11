import { FIXTURE_MANAGED_POLICY } from "@opensesame/app-core/lib/configuration/doubles/composition-fixture.js";
import {
  double,
  resetDouble,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { installDoublePorts } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
/** @vitest-environment jsdom */
import {
  connectRoadSeams,
  notifyConnectRoads,
  resetConnectRoadSeams,
} from "@opensesame/app-core/lib/connect-roads.js";
import { hasConnectRoute } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { usesConnect } from "@opensesame/app-core/lib/vercel-connect.js";
import type { InstallationCapabilitySelection } from "@opensesame/capability-composition";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PERSONAL_SELECTION,
  installPanelFixture,
  openConnectorPages,
  renderPanel,
  withReceipt,
} from "./capabilities-panel.test-support.js";

import { activateForTest } from "../../modules/runtime-test-kit.js";
import * as localAi from "../../modules/support.local-ai/runtime.js";

installDoublePorts();

installPanelFixture();

afterEach(() => {
  resetConnectRoadSeams();
  notifyConnectRoads();
});

/** Reset to a selection with a receipt that covers exactly its closure. */
function selecting(selectedOptional: string[], transport?: string) {
  const chosenAlternatives: InstallationCapabilitySelection["chosenAlternatives"] =
    transport === undefined ? {} : { transport };
  const selection = {
    ...PERSONAL_SELECTION,
    selectedOptional,
    chosenAlternatives,
  };
  const exposure: Record<string, string> = {};
  for (const id of double.preview(selection).approvedCapabilities)
    exposure[id] = `sha256:fixture-${id}`;
  resetDouble({
    selection,
    receipt: { ...withReceipt(), roots: selectedOptional, exposure },
  });
}

describe("what a switch cannot say is said beside it", () => {
  it("offers no Shared drops switch; sending one is always on", () => {
    selecting(["sharing.household"], "sharing.drops");
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Shared drops" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Secret drops" })).toBeNull();
    expect(
      screen
        .getByRole("switch", { name: "Household sharing" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("draws AI's model picks only while AI is on", async () => {
    // The fixture runs WebMCP tools, so AI is on — and the picker is the
    // on-device model's own panel, so it arrives with that capability.
    const revoke = await activateForTest(localAi, ["settings-panel"]);
    const on = renderPanel();
    expect(on.container.querySelector("#model-provider")).not.toBeNull();
    cleanup();
    selecting(["vault.passkey-records"]);
    const off = renderPanel();
    expect(off.container.querySelector("#model-provider")).toBeNull();
    // Connectors stay configurable by reference once Connect's roads are installed.
    connectRoadSeams.usesConnect = usesConnect;
    connectRoadSeams.hasConnectRoute = hasConnectRoute;
    openConnectorPages();
    cleanup();
    const referenced = renderPanel();
    expect(
      referenced.getByRole("list", { name: "AI providers" }).textContent,
    ).toContain("Anthropic");
    revoke();
  });

  it("says when an operator withdrew an always-on capability", () => {
    resetDouble({
      policy: {
        ...FIXTURE_MANAGED_POLICY,
        capabilities: {
          ...FIXTURE_MANAGED_POLICY.capabilities,
          prohibited: [
            ...FIXTURE_MANAGED_POLICY.capabilities.prohibited,
            "settings.core",
          ],
        },
      },
      provenance: "same-origin-deployment",
    });
    renderPanel();
    expect(screen.getByTestId("capabilities-withdrawn").textContent).toContain(
      "withdrawn by operator: Settings",
    );
  });

  it("says nothing when nothing is withdrawn", () => {
    renderPanel();
    expect(screen.queryByTestId("capabilities-withdrawn")).toBeNull();
  });
});
