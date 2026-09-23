/**
 * The shared fixture of the Settings › Capabilities panel tests: a personal
 * installation that selected WebMCP (and a now-core id, ignored), a receipt
 * covering it, and a vault the test may change through `panelVault`.
 *
 * Each test file still declares its own `vi.mock` of the capability ports.
 */

import {
  double,
  resetDouble,
} from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, vi } from "vitest";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import {
  CapabilitiesPanel,
  capabilitiesPanelSeams,
} from "./CapabilitiesPanel.js";

export function renderPanel() {
  return render(
    <MemoryRouter>
      <CapabilitiesPanel />
    </MemoryRouter>,
  );
}

/** Who is in front of the panel; reset before every test. */
export const panelVault = { current: { tomb: "personal", guest: false } };

export const PERSONAL_SELECTION = {
  schemaVersion: 1 as const,
  kind: "InstallationCapabilitySelection" as const,
  instanceId: "personal-local",
  installationId: "inst-1",
  basePolicyRevision: "0",
  revision: "1",
  acceptedRequired: [],
  selectedOptional: ["agents.webmcp", "vault.passkey-records"],
  chosenAlternatives: {},
  delivery: { prefetch: "none" as const, offlineCache: "shell-only" as const },
};

export function withReceipt() {
  const plan = double.preview(PERSONAL_SELECTION);
  const exposure: Record<string, string> = {};
  for (const id of plan.approvedCapabilities)
    exposure[id] = `sha256:fixture-${id}`;
  return {
    schemaVersion: 1 as const,
    instanceId: "personal-local",
    installationId: "inst-1",
    policyRevision: "0",
    selectionRevision: "1",
    acceptedAt: "2026-09-22T00:00:00Z",
    roots: ["agents.webmcp", "vault.passkey-records"],
    exposure,
    receiptDigest: "sha256:r",
  };
}

/** Registers the per-test reset; call once at the top of a test file. */
export function installPanelFixture(): void {
  const realUseVault = vaultHooksSeams.useVault;
  const realNow = capabilitiesPanelSeams.now;
  beforeEach(() => {
    panelVault.current = { tomb: "personal", guest: false };
    vaultHooksSeams.useVault = () => ({
      ...realUseVault(),
      ...panelVault.current,
    });
    resetDouble({ selection: PERSONAL_SELECTION, receipt: withReceipt() });
    double.setActive("agents.webmcp");
    capabilitiesPanelSeams.reload = vi.fn();
    capabilitiesPanelSeams.now = realNow;
  });
  afterEach(() => {
    cleanup();
    capabilitiesPanelSeams.now = realNow;
    vaultHooksSeams.useVault = realUseVault;
  });
}
