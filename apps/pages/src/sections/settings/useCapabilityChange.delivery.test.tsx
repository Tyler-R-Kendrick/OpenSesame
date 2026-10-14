/** @vitest-environment jsdom */
import {
  double,
  installDoublePorts,
  resetDouble,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import type { InstallationCapabilitySelection } from "@opensesame/capability-composition";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  PERSONAL_SELECTION,
  installPanelFixture,
  renderPanel,
  withReceipt,
} from "./settings-panels.test-support.js";
import { selectionFor } from "./useCapabilityChange.js";

installDoublePorts();
installPanelFixture();

it.each<InstallationCapabilitySelection["delivery"]>([
  { prefetch: "selected", offlineCache: "selected-only" },
  { prefetch: "none", offlineCache: "selected-only" },
  { prefetch: "selected", offlineCache: "shell-only" },
])("preserves delivery %j when Connections is enabled", async (delivery) => {
  resetDouble({
    selection: { ...PERSONAL_SELECTION, delivery },
    receipt: withReceipt(),
  });
  renderPanel();
  const connections = screen.getByRole("switch", {
    name: "Connections",
  });
  fireEvent.click(connections);
  await waitFor(() => {
    expect(connections.getAttribute("aria-checked")).toBe("true");
    expect(double.commits[0]?.draft.selectedOptional).toContain(
      "connectors.external",
    );
    expect(double.commits[0]?.draft.delivery).toEqual(delivery);
    expect(double.getSnapshot().selection?.delivery).toEqual(delivery);
  });
});

it("keeps the first-setup delivery defaults when there is no existing selection", () => {
  resetDouble({ selection: null, receipt: null });
  const selection = selectionFor(double.getSnapshot(), {
    roots: ["connectors.external"],
    alternatives: {},
  });
  expect(selection.selectedOptional).toContain("connectors.external");
  expect(selection.delivery).toEqual({
    prefetch: "none",
    offlineCache: "shell-only",
  });
  expect(double.commits).toEqual([]);
});
