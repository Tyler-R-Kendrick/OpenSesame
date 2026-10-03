import type {
  CapabilityState,
  EffectivePlan,
} from "@opensesame/capability-composition";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_CATALOG,
  describeCapability,
} from "../capabilities/catalog.js";
import { createEgressPort } from "../capabilities/egress.js";
import { PluginError, readPluginStates } from "../plugins/client.js";
import { pairedDrive } from "./observer.js";
import type { DrivePairing } from "./pairing.js";
import { pluginDaemonSeams, tailnetPluginDaemon } from "./plugin-daemon.js";

const CAPABILITY = "agents.surrogate-credentials";
const KEY = "Qm9ndXMtZXZpZGVuY2Uta2V5LW5vdC1hLXJlYWwtb25l";
const DRIVE: DrivePairing = {
  url: "https://desk.tail4c2e.ts.net",
  slot: "5b1c2d3e-0f4a-4b6c",
  key: KEY,
  label: "Personal vault",
};

/** A plan in which exactly `approved` (plus core) runs. */
function planWith(approved: readonly string[]): EffectivePlan {
  const capabilities: Record<string, CapabilityState> = {};
  for (const entry of CAPABILITY_CATALOG.capabilities) {
    const on = entry.tier === "core" || approved.includes(entry.id);
    capabilities[entry.id] = {
      id: entry.id,
      tier: entry.tier,
      distributed: true,
      permitted: true,
      required: false,
      selected: on,
      dependencyOf: [],
      runtimeSupported: true,
      missingEnvironments: [],
      approved: on,
      restartRequired: false,
      reasons: [],
    };
  }
  return {
    identity: {
      instanceId: "personal-local",
      installationId: "plugin-daemon-test",
      vaultId: null,
      distributionId: "plugin-daemon-test",
      policyRevision: "personal-local",
      selectionRevision: "1",
      planDigest: "sha256:plugin-daemon-test",
    },
    provenance: "personal-local",
    policyValid: true,
    capabilities,
    approvedCapabilities: Object.keys(capabilities).filter(
      (id) => capabilities[id]?.approved,
    ),
    approvedModules: [],
    approvedOperations: [],
    approvedItemKinds: [],
    requiredWorkerVariant: null,
    conflicts: [],
    consent: {
      addedRoots: [],
      removedRoots: [],
      changedExposure: [],
      addedDependencies: [],
      requiredNotAccepted: [],
    },
    network: { externalServices: "allow", allowedServiceOrigins: [] },
  };
}

function setup(approved: readonly string[], pairing: DrivePairing | null) {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ plugins: [] }), { status: 200 }),
  );
  const descriptor = describeCapability(CAPABILITY);
  if (!descriptor) throw new Error("catalog lacks the capability");
  const egress = createEgressPort({
    capability: descriptor,
    plan: () => planWith(approved),
    allowedOrigins: ["https://tyler-r-kendrick.github.io"],
    mayPairLocalAuthority: () => true,
    fetchImpl,
  });
  vi.spyOn(pluginDaemonSeams, "pairing").mockReturnValue(pairing);
  return { fetchImpl, daemon: tailnetPluginDaemon(egress, CAPABILITY) };
}

const signal = new AbortController().signal;

describe("the tailnet daemon as the plugin port", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries the pairing key in the Authorization header only, never in the URL", async () => {
    const { fetchImpl, daemon } = setup([CAPABILITY], DRIVE);
    await readPluginStates(daemon, signal);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://desk.tail4c2e.ts.net/v1/plugins");
    expect(String(url)).not.toContain(KEY);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${KEY}`,
    );
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("manual");
  });

  it("never hands the key to a pairing that points off the tailnet", async () => {
    const { fetchImpl, daemon } = setup([CAPABILITY], {
      ...DRIVE,
      url: "https://attacker.example",
    });
    await expect(readPluginStates(daemon, signal)).rejects.toBeInstanceOf(
      PluginError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends nothing once the plan no longer approves the capability", async () => {
    const { fetchImpl, daemon } = setup([], DRIVE);
    await expect(readPluginStates(daemon, signal)).rejects.toMatchObject({
      code: "unreachable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends nothing and names no daemon with nothing paired", async () => {
    const { fetchImpl, daemon } = setup([CAPABILITY], null);
    expect(daemon.target()).toBeNull();
    await expect(readPluginStates(daemon, signal)).rejects.toMatchObject({
      code: "no-daemon",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the daemon by host, never by key or full address", () => {
    const { daemon } = setup([CAPABILITY], DRIVE);
    expect(daemon.target()).toEqual({
      label: "Personal vault",
      host: "desk.tail4c2e.ts.net",
    });
    expect(JSON.stringify(daemon.target())).not.toContain(KEY);
  });

  it("has no pairing to offer while the tailnet observer holds none (a locked vault, a guest)", () => {
    expect(pairedDrive()).toBeNull();
  });
});
