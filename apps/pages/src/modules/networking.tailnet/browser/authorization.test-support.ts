/** Real vault/runtime authority; only Go's Worker message boundary is controlled. */
import {
  CAPABILITY_CATALOG,
  describeCapability,
} from "@opensesame/app-core/lib/capabilities/catalog.js";
import { createEgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import { mintLease } from "@opensesame/app-core/lib/capabilities/lease.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceConnection } from "@opensesame/app-core/lib/device-connectors.js";
import {
  deferred,
  runtimeFixture,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { tailscaleBrowserNode } from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import * as nodeState from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  buildConsentReceipt,
  fixtureResolveInput,
  fixtureSelection,
  resolveComposition,
} from "@opensesame/capability-composition";
import type { BoundaryValue } from "@opensesame/os-domain";
import { vi } from "vitest";
import { createActivation } from "../../activation.js";
import { createTestContext } from "../../test-context.js";
import { bindTailscaleBrowserRuntime } from "./runtime.js";

export const config = {
  hostname: "status-browser",
  controlURL: "https://controlplane.tailscale.com",
};
/** Delivers on the same turn, so a test reads the controller as the worker left it. */
class SyncPort {
  onmessage: ((event: { data: BoundaryValue }) => void) | null = null;
  other: SyncPort | null = null;
  postMessage(data: BoundaryValue) {
    this.other?.onmessage?.({ data });
  }
  close() {
    this.other = null;
  }
}
export class SyncChannel {
  readonly port1 = new SyncPort();
  readonly port2 = new SyncPort();
  constructor() {
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}
/** `start` arrives on the Worker; everything after it, both ways, on its port. */
export class StatusWorker {
  static current: StatusWorker;
  onerror: (() => void) | null = null;
  sent: BoundaryValue[] = [];
  terminated = false;
  private port: SyncPort | null = null;
  constructor() {
    StatusWorker.current = this;
  }
  postMessage(value: BoundaryValue, transfer: SyncPort[] = []) {
    this.sent.push(value);
    const [port] = transfer;
    if (!port) return;
    this.port = port;
    port.onmessage = (event) => this.sent.push(event.data);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: BoundaryValue) {
    this.port?.postMessage(data);
  }
}
export function stubBrowserNodeWorker() {
  vi.stubGlobal("Worker", StatusWorker);
  vi.stubGlobal("MessageChannel", SyncChannel);
}
export function netmap(
  worker: StatusWorker,
  addresses = ["100.64.0.3"],
  machineStatus = "MachineAuthorized",
) {
  worker.emit({
    kind: "netmap",
    value: JSON.stringify({
      self: { machineStatus, addresses },
      peers: [],
      lockedOut: false,
    }),
  });
}
function networkingPlan() {
  const input = fixtureResolveInput({
    catalog: CAPABILITY_CATALOG,
    installation: fixtureSelection({
      selectedOptional: ["networking.tailnet"],
    }),
  });
  const distribution = {
    ...input.distribution,
    capabilityIds: CAPABILITY_CATALOG.capabilities.map((item) => item.id),
    moduleIds: CAPABILITY_CATALOG.capabilities.flatMap(
      (item) => item.moduleIds,
    ),
  };
  const base = { ...input, distribution };
  const resolved = resolveComposition(base);
  const receipt = buildConsentReceipt(
    resolved,
    CAPABILITY_CATALOG,
    input.facts.now,
  );
  const approved = resolveComposition({ ...base, receipt });
  if (!approved.capabilities["networking.tailnet"]?.approved)
    throw new Error("Networking fixture must have actual resolver approval");
  const plan = {
    ...approved,
    network: {
      ...approved.network,
      externalServices: "allow" as const,
      allowedServiceOrigins: [new URL(config.controlURL).origin],
    },
  };
  return plan;
}
export async function statusFixture() {
  const vault = await runtimeFixture();
  stubBrowserNodeWorker();
  const test = createTestContext();
  const authority = mintLease(test.ctx.lease.identity, 1);
  const plan = networkingPlan();
  const capability = describeCapability("networking.tailnet");
  if (!capability) throw new Error("Missing real Networking capability");
  const fetcher = vi.fn<typeof fetch>();
  const egress = createEgressPort({
    capability,
    plan: () => plan,
    allowedOrigins: [location.origin],
    fetchImpl: fetcher,
    mayPairLocalAuthority: () => true,
  });
  const ctx = { ...test.ctx, lease: authority.lease, egress };
  const activation = createActivation(ctx, "networking.tailnet");
  bindTailscaleBrowserRuntime(ctx, activation);
  const node = tailscaleBrowserNode();
  if (!node) throw new Error("Missing actual bound controller");
  const releases: (() => void)[] = [];
  return {
    node,
    vault,
    plan,
    fetcher,
    activation,
    revoke: () => authority.abort("Networking withdrawn"),
    async start() {
      await node.start(config);
      return StatusWorker.current;
    },
    async connect() {
      await node.start(config);
      const worker = StatusWorker.current;
      worker.emit({
        kind: "storage",
        state: { key: "fixture-encrypted-sdk-state" },
      });
      netmap(worker);
      worker.emit({ kind: "state", state: "Running" });
      await vi.waitFor(() => {
        if (node.snapshot().status !== "connected")
          throw new Error("Not connected yet");
      });
      return worker;
    },
    connection() {
      const row = readDeviceRows().find(
        (entry) => entry.fields.tailscale_browser_node !== undefined,
      );
      const connection = row && deviceConnection(row.connectionId);
      if (!connection) throw new Error("Missing actual node connection");
      return connection;
    },
    holdReceipt() {
      const original = nodeState.writeBrowserNodeState;
      const entered = deferred<void>();
      const gate = deferred<void>();
      releases.push(() => gate.resolve());
      vi.spyOn(nodeState, "writeBrowserNodeState").mockImplementationOnce(
        async (...args) => {
          const receipt = await original(...args);
          entered.resolve();
          await gate.promise;
          return receipt;
        },
      );
      return { ready: entered.promise, release: () => gate.resolve() };
    },
    async editToken() {
      const item = vaultStore.getSnapshot().items[0];
      if (!item || item.kind !== "credential" || item.method.type !== "token")
        throw new Error("Missing actual node token");
      await vaultStore.saveItem({
        ...item,
        method: { ...item.method, token: '{"key":"person-edited"}' },
      });
    },
    async close() {
      activation.dispose();
      for (const release of releases) release();
      await vault.close();
    },
  };
}
