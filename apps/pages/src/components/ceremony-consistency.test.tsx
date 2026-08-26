/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectionSeams } from "../lib/connections.js";
import { CONNECTOR_IDS, type ConnectorStatus } from "../lib/connectors.js";
import { daemonSeams } from "../lib/daemon.js";
import { planeSeams } from "../lib/planes.js";
import { settingsSeams } from "../lib/settings.js";
import { tailscaleSeams } from "../lib/tailscale.js";
import { ConnectionCeremony } from "./ConnectivityBar.js";

/**
 * One shape, five ceremonies — enforced, not hoped for.
 *
 * The first implementation of the connection sheet drifted exactly this way:
 * the machine ceremony got the designed card-and-alternatives treatment and
 * the other four degraded into a sentence and a link to Settings. Each
 * ceremony's own test file pins its behaviour; this sweep pins the *shape*,
 * across every connector the bar knows, with the real ceremony bodies —
 * so the sixth connector cannot ship as a signpost either.
 *
 * The contract, per `docs/design/settings-connectivity/Main.dc.html`:
 *  - a `.found` card stating what was found;
 *  - a standing footnote in the sheet's foot;
 *  - no anchor anywhere — an alternative expands in the sheet, it never
 *    navigates.
 */
const originalPlaneSeams = { ...planeSeams };
const originalSettingsSeams = { ...settingsSeams };
const originalConnectionSeams = { ...connectionSeams };
const originalDaemonSeams = { ...daemonSeams };
const originalTailscaleSeams = { ...tailscaleSeams };

function status(id: ConnectorStatus["id"]): ConnectorStatus {
  return {
    id,
    name: id,
    tone: "attn",
    detail: "detail",
    required: true,
    failure: null,
    lastCheckedAt: null,
    checking: false,
    rttMs: null,
  };
}

beforeEach(() => {
  // Enough of the world that every real ceremony body renders quietly: no
  // plane answers, no connections load, discovery finds nothing.
  Object.assign(planeSeams, {
    usePlaneStatus: () => ({
      host: "down" as const,
      hostBase: "http://127.0.0.1:18787",
      identity: "down" as const,
      identityBase: "http://127.0.0.1:18788",
    }),
  });
  Object.assign(settingsSeams, { pageIsLoopback: () => true });
  Object.assign(connectionSeams, {
    listConnections: vi.fn().mockResolvedValue([]),
    listProviders: vi.fn().mockResolvedValue([]),
    listIntegrations: vi.fn().mockResolvedValue([]),
  });
  Object.assign(daemonSeams, {
    probeDaemon: vi.fn().mockRejectedValue(new Error("nothing listening")),
  });
  Object.assign(tailscaleSeams, {
    assertDaemonReachableFromPage: vi.fn(),
    detectTailnet: vi.fn().mockResolvedValue(true),
    discoverTailscaleDaemon: vi
      .fn()
      .mockRejectedValue(new Error("nothing found")),
    openTailscaleLogin: vi.fn(),
    waitForTailnet: vi.fn().mockResolvedValue(false),
  });
});

afterEach(() => {
  cleanup();
  Object.assign(planeSeams, originalPlaneSeams);
  Object.assign(settingsSeams, originalSettingsSeams);
  Object.assign(connectionSeams, originalConnectionSeams);
  Object.assign(daemonSeams, originalDaemonSeams);
  Object.assign(tailscaleSeams, originalTailscaleSeams);
  vi.restoreAllMocks();
});

describe("every ceremony wears the same shape", () => {
  for (const id of CONNECTOR_IDS) {
    it(`${id}: card, footnote, and not one anchor`, async () => {
      const { container } = render(
        <ConnectionCeremony
          id={id}
          connectors={CONNECTOR_IDS.map(status)}
          onClose={() => {}}
          onSwitch={() => {}}
        />,
      );
      // The machine ceremony probes on open; let it settle into its card.
      expect(await screen.findByRole("dialog")).toBeTruthy();
      await vi.waitFor(() => {
        expect(container.querySelector(".found")).toBeTruthy();
      });
      expect(container.querySelector(".sheet__foot")).toBeTruthy();
      // The rule the whole redesign hangs on: repairing a connection puts
      // you back where you were, so nothing in a ceremony navigates.
      expect(container.querySelector("a")).toBeNull();
    });
  }
});
