/** @vitest-environment jsdom */
import { FIXTURE_MANAGED_POLICY } from "@opensesame/app-core/lib/configuration/doubles/composition-fixture.js";
import {
  double,
  resetDouble,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { cleanup, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  PERSONAL_SELECTION,
  installPanelFixture,
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

/** Reset to a selection with a receipt that covers exactly its closure. */
function selecting(
  selectedOptional: string[],
  chosenAlternatives: Record<string, string> = {},
) {
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
  it("a capability another kept root needs offers no switch that cannot take", () => {
    selecting(["sharing.drops", "sharing.household"], {
      transport: "sharing.drops",
    });
    renderPanel();
    expect(screen.queryByRole("switch", { name: "Shared drops" })).toBeNull();
    expect(
      screen.getByRole("img", { name: "needed by Household sharing" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "Household sharing" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("draws AI's model picks only while AI is on", () => {
    // The fixture runs WebMCP tools, so AI is on.
    const on = renderPanel();
    expect(on.container.querySelector("#model-provider")).not.toBeNull();
    cleanup();
    selecting(["vault.passkey-records"]);
    const off = renderPanel();
    expect(off.container.querySelector("#model-provider")).toBeNull();
    // Its connectors are still configured by reference.
    expect(
      screen.getByRole("list", { name: "AI providers" }).textContent,
    ).toContain("Anthropic");
  });

  it("says when a policy's prohibition names a capability that is always on", () => {
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
    expect(screen.getByTestId("capabilities-ignored").textContent).toContain(
      "Settings",
    );
  });

  it("says nothing when no prohibition is ignored", () => {
    renderPanel();
    expect(screen.queryByTestId("capabilities-ignored")).toBeNull();
  });
});
