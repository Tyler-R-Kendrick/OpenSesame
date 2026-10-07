import { expect, it, vi } from "vitest";
import { configureHost, host } from "../../host.js";
import * as kv from "../kv.js";
import { deliverObservation } from "./delivery.js";
import { observationPlan } from "./plan-test-support.js";
import { appendObservation } from "./queue.js";
import { configureObservationReceiver } from "./receiver.js";
import {
  outboxKey,
  readReceiverConfig,
  withObservationLock,
} from "./storage.js";
import { fixture, metadata, owner, provision } from "./test-support.js";
async function ready() {
  const f = await fixture();
  await configureObservationReceiver({
    ...owner,
    provision: provision("https://receiver.example.test"),
    enabled: false,
  });
  const config = await readReceiverConfig(owner.tomb);
  if (!config) throw new Error("Missing bound receiver.");
  const packet = await withObservationLock(owner.tomb, () =>
    appendObservation(config, metadata(f.identity), true),
  );
  if (!packet) throw new Error("Missing sealed package.");
  return { ...f, packet };
}
it("no plan and external-service-denied plans cannot dispatch registered sealed metadata", async () => {
  const f = await ready();
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    f.plan.set(null);
    await expect(
      deliverObservation(owner.tomb, f.packet.packageId, true),
    ).rejects.toThrow("resolved plan");
    const plan = observationPlan();
    f.plan.set({
      ...plan,
      network: { ...plan.network, externalServices: "deny" },
    });
    await expect(
      deliverObservation(owner.tomb, f.packet.packageId, true),
    ).rejects.toThrow("current plan");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});
it("an origin restriction installed during the final awaited outbox read prevents actual fetch", async () => {
  const f = await ready();
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const original = kv.kvRefresh;
  let reads = 0;
  const refresh = vi
    .spyOn(kv, "kvRefresh")
    .mockImplementation(async (key, max) => {
      await original(key, max);
      if (key === outboxKey(owner.tomb) && ++reads === 2) {
        const plan = observationPlan();
        f.plan.set({
          ...plan,
          network: {
            ...plan.network,
            allowedServiceOrigins: ["https://other.example.test"],
          },
        });
      }
    });
  try {
    expect(await deliverObservation(owner.tomb, f.packet.packageId, true)).toBe(
      false,
    );
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    refresh.mockRestore();
    fetchSpy.mockRestore();
  }
});

it("a page without a permitted deployment profile cannot borrow the headless metadata fact", async () => {
  const f = await ready();
  const current = host();
  const { securityProfile: ignored, ...withoutProfile } = current;
  void ignored;
  configureHost({ ...withoutProfile, observationRuntime: "human-node-cli" });
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    const config = await readReceiverConfig(owner.tomb);
    if (!config) throw new Error("Missing receiver.");
    const { assertObservationEgress } = await import("./egress-admission.js");
    expect(() =>
      assertObservationEgress(
        "http://127.0.0.1:18791/v1/credential-observations",
      ),
    ).toThrow("current plan");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(f.plan).toBeDefined();
  } finally {
    fetchSpy.mockRestore();
    configureHost(current);
  }
});
