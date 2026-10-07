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
import { localNetworkFetchSeams } from "../local-network-fetch.js";
import { PluginError, readPluginStates } from "../plugins/client.js";
import { currentPluginPairing } from "./plugin-daemon-store.js";
import { pluginDaemonSeams, tailnetPluginDaemon } from "./plugin-daemon.js";
import {
  type PluginDaemonPairing,
  formatPluginPairingCode,
} from "./plugin-pairing.js";

const CAPABILITY = "agents.surrogate-credentials";
const PAGES = "https://tyler-r-kendrick.github.io";
const TOKEN = "UGx1Z2luLWRhZW1vbi1rZXktbm90LWEtcmVhbC0wMSE"; // gitleaks:allow — validated synthetic fixture or fixed non-secret identifier
const CODE = "UGx1Z2luLXBhaXJpbmctY29kZS1ub3QtcmVhbC0wMSE";
const PAIRED: PluginDaemonPairing = {
  url: "https://desk.tail4c2e.ts.net",
  token: TOKEN,
  origin: PAGES,
  label: "Desk",
};
const PASTED = formatPluginPairingCode({
  url: PAIRED.url,
  code: CODE,
  origin: PAGES,
  label: "Desk",
});

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

type Answer = () => Response;

function setup(
  approved: readonly string[],
  pairing: PluginDaemonPairing | null,
  answer: Answer = () =>
    new Response(JSON.stringify({ plugins: [] }), { status: 200 }),
) {
  const fetchImpl = vi.fn<typeof fetch>(async () => answer());
  const descriptor = describeCapability(CAPABILITY);
  if (!descriptor) throw new Error("catalog lacks the capability");
  const egress = createEgressPort({
    capability: descriptor,
    plan: () => planWith(approved),
    allowedOrigins: [PAGES],
    mayPairLocalAuthority: () => true,
    fetchImpl,
  });
  vi.spyOn(pluginDaemonSeams, "pairing").mockReturnValue(pairing);
  vi.spyOn(pluginDaemonSeams, "pageOrigin").mockReturnValue(PAGES);
  const possible = vi
    .spyOn(pluginDaemonSeams, "possible")
    .mockReturnValue(true);
  const keep = vi.spyOn(pluginDaemonSeams, "keep").mockResolvedValue();
  const drop = vi.spyOn(pluginDaemonSeams, "drop").mockResolvedValue();
  return {
    fetchImpl,
    keep,
    drop,
    possible,
    daemon: tailnetPluginDaemon(egress, CAPABILITY),
  };
}

const signal = new AbortController().signal;
const issued =
  (origin = PAGES) =>
  () =>
    new Response(JSON.stringify({ id: "4f2a", origin, token: TOKEN }), {
      status: 201,
    });

describe("the paired daemon as the plugin port", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries the key in the Authorization header only, never in the URL", async () => {
    const { fetchImpl, daemon } = setup([CAPABILITY], PAIRED);
    await readPluginStates(daemon, signal);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://desk.tail4c2e.ts.net/v1/plugins");
    expect(String(url)).not.toContain(TOKEN);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("manual");
  });

  it("never hands the key to a pairing that points off the tailnet", async () => {
    const { fetchImpl, daemon } = setup([CAPABILITY], {
      ...PAIRED,
      url: "https://attacker.example",
    });
    await expect(readPluginStates(daemon, signal)).rejects.toBeInstanceOf(
      PluginError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends nothing once the plan no longer approves the capability", async () => {
    const { fetchImpl, daemon } = setup([], PAIRED);
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
    const { daemon } = setup([CAPABILITY], PAIRED);
    expect(daemon.target()).toEqual({
      label: "Desk",
      host: "desk.tail4c2e.ts.net",
      revision: pluginDaemonSeams.revision(),
    });
    expect(JSON.stringify(daemon.target())).not.toContain(TOKEN);
  });

  it("refuses, and sends no key, a call issued for a pairing no longer in force", async () => {
    const { fetchImpl, daemon } = setup([CAPABILITY], PAIRED);
    const issuedFor = daemon.target();
    if (!issuedFor) throw new Error("no target");
    const init = { method: "GET", signal, expect: issuedFor } as const;
    vi.spyOn(pluginDaemonSeams, "revision").mockReturnValue(
      issuedFor.revision + 1,
    );
    await expect(daemon.request("/v1/plugins", init)).rejects.toMatchObject({
      code: "target-changed",
    });
    vi.spyOn(pluginDaemonSeams, "revision").mockReturnValue(issuedFor.revision);
    vi.spyOn(pluginDaemonSeams, "pairing").mockReturnValue({
      ...PAIRED,
      url: "https://lab.tail4c2e.ts.net",
    });
    await expect(daemon.request("/v1/plugins", init)).rejects.toMatchObject({
      code: "target-changed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends a call issued for the pairing that is in force", async () => {
    const { fetchImpl, daemon } = setup([CAPABILITY], PAIRED);
    const expect_ = daemon.target() ?? undefined;
    await daemon.request("/v1/plugins", {
      method: "GET",
      signal,
      expect: expect_,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("has no pairing to offer with no vault open", () => {
    expect(currentPluginPairing()).toBeNull();
    expect(pluginDaemonSeams.possible()).toBe(false);
  });

  it("pairs nothing on a deployment that may hold no local authority", () => {
    vi.spyOn(localNetworkFetchSeams, "eligible").mockReturnValue(false);
    expect(pluginDaemonSeams.possible()).toBe(false);
  });
});

describe("pairing from a pasted code", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("trades the code once at the daemon it names and seals the key it gets", async () => {
    const { fetchImpl, keep, daemon } = setup([CAPABILITY], null, issued());
    await daemon.pair?.(PASTED, signal);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://desk.tail4c2e.ts.net/v1/plugins/pairing");
    expect(String(url)).not.toContain(CODE);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ code: CODE });
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
    expect(init?.credentials).toBe("omit");
    expect(keep).toHaveBeenCalledWith(PAIRED, expect.anything());
  });

  it("refuses, and sends nothing for, a code printed for another page", async () => {
    const { fetchImpl, keep, daemon } = setup([CAPABILITY], null, issued());
    vi.spyOn(pluginDaemonSeams, "pageOrigin").mockReturnValue(
      "http://localhost:5180",
    );
    await expect(daemon.pair?.(PASTED, signal)).rejects.toMatchObject({
      code: "other-origin",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(keep).not.toHaveBeenCalled();
  });

  it("refuses, and sends nothing for, what is not a code or points off the tailnet", async () => {
    const { fetchImpl, daemon } = setup([CAPABILITY], null, issued());
    const offTailnet = formatPluginPairingCode({
      url: "https://attacker.example",
      code: CODE,
      origin: PAGES,
      label: "",
    });
    for (const raw of ["", CODE, offTailnet, `opensesame-drive:v1:${CODE}`])
      await expect(daemon.pair?.(raw, signal)).rejects.toMatchObject({
        code: "not-a-code",
      });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends nothing with no open vault to seal the key in", async () => {
    const { fetchImpl, possible, daemon } = setup([CAPABILITY], null, issued());
    possible.mockReturnValue(false);
    expect(daemon.canPair?.()).toBe(false);
    await expect(daemon.pair?.(PASTED, signal)).rejects.toMatchObject({
      code: "locked",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps nothing the daemon refused, or issued for another origin", async () => {
    const refused = setup(
      [CAPABILITY],
      null,
      () =>
        new Response(JSON.stringify({ error: "pairing_refused" }), {
          status: 403,
        }),
    );
    await expect(refused.daemon.pair?.(PASTED, signal)).rejects.toMatchObject({
      code: "pairing-refused",
    });
    expect(refused.keep).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const elsewhere = setup(
      [CAPABILITY],
      null,
      issued("https://attacker.example"),
    );
    await expect(elsewhere.daemon.pair?.(PASTED, signal)).rejects.toMatchObject(
      { code: "malformed" },
    );
    expect(elsewhere.keep).not.toHaveBeenCalled();
  });

  it("forgetting revokes the key at the daemon, and forgets it even when unanswered", async () => {
    const { fetchImpl, drop, daemon } = setup(
      [CAPABILITY],
      PAIRED,
      () => new Response(null, { status: 204 }),
    );
    await daemon.forget?.(signal);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://desk.tail4c2e.ts.net/v1/plugins/pairing");
    expect(init?.method).toBe("DELETE");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(drop).toHaveBeenCalledTimes(1);
    fetchImpl.mockRejectedValue(new TypeError("offline"));
    await daemon.forget?.(signal);
    expect(drop).toHaveBeenCalledTimes(2);
  });
});
