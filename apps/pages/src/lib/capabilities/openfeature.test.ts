import {
  ErrorCode,
  type EventDetails,
  InMemoryProvider,
  type JsonValue,
  OpenFeature,
  ProviderEvents,
  ProviderStatus,
  StandardResolutionReasons,
} from "@openfeature/web-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAMILY_POLICY,
  approvedPlan,
  readySnapshot,
  resolvingSnapshot,
  storeDouble,
} from "./__tests__/plan-fixtures.js";
import {
  FLAG_GENERATION,
  FLAG_PLAN,
  LocalCompositionProvider,
  OPENFEATURE_DOMAIN,
  PROVIDER_NAME,
  capabilityFlagKey,
  foreignProviderInstalled,
  installCompositionProvider,
  installedCompositionProvider,
  lifecycleFlagKey,
  projectedContext,
} from "./openfeature.js";

const CONNECTORS = "connectors.external";
const TELEMETRY = "telemetry.external";

describe("LocalCompositionProvider (S17)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(async () => {
    await OpenFeature.clearProviders();
    vi.unstubAllGlobals();
  });

  it("OF-01: installs and answers offline, with no network at all", async () => {
    const plan = approvedPlan([CONNECTORS]);
    expect(plan.capabilities[CONNECTORS]?.approved).toBe(true);
    const store = storeDouble(readySnapshot(plan, 3));
    const { client, provider, dispose } = await installCompositionProvider({
      snapshotSource: store,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(provider.metadata.name).toBe(PROVIDER_NAME);
    expect(provider.runsOn).toBe("client");
    expect(client.providerStatus).toBe(ProviderStatus.READY);
    expect(installedCompositionProvider()).toBe(provider);
    const details = client.getBooleanDetails(capabilityFlagKey(CONNECTORS), false);
    expect(details.value).toBe(true);
    expect(details.reason).toBe(StandardResolutionReasons.TARGETING_MATCH);
    expect(details.flagMetadata).toEqual({ generation: 3 });
    expect(client.getBooleanValue(capabilityFlagKey(TELEMETRY), false)).toBe(false);
    expect(client.getNumberDetails(FLAG_GENERATION, -1)).toMatchObject({
      value: 3,
      reason: StandardResolutionReasons.STATIC,
    });
    expect(client.getStringValue(lifecycleFlagKey(CONNECTORS), "")).toBe(
      "approved-not-loaded",
    );
    expect(client.getObjectValue(FLAG_PLAN, {})).toEqual({
      planDigest: plan.identity.planDigest,
      approvedCapabilities: [...plan.approvedCapabilities],
    });
    await dispose();
  });

  it("OF-02: a store that is not ready resolves every default and the SDK keeps going", async () => {
    const store = storeDouble(resolvingSnapshot(0));
    const { client } = await installCompositionProvider({ snapshotSource: store });
    const details = client.getBooleanDetails(capabilityFlagKey(CONNECTORS), false);
    expect(details.value).toBe(false);
    expect(details.errorCode).toBe(ErrorCode.PROVIDER_NOT_READY);
    expect(details.reason).toBe(StandardResolutionReasons.ERROR);
    expect(client.getNumberValue(FLAG_GENERATION, -1)).toBe(-1);
    expect(client.getObjectValue(FLAG_PLAN, { empty: true })).toEqual({ empty: true });
    const plan = approvedPlan([CONNECTORS]);
    store.set(readySnapshot(plan, 1));
    expect(client.getBooleanValue(capabilityFlagKey(CONNECTORS), false)).toBe(true);
  });

  it("OF-03: an unknown key and a wrong type both answer the caller's default with a code", async () => {
    const store = storeDouble(readySnapshot(approvedPlan([CONNECTORS]), 2));
    const { client } = await installCompositionProvider({ snapshotSource: store });
    const unknown = client.getBooleanDetails("capability.not.a-capability", false);
    expect(unknown).toMatchObject({ value: false, errorCode: ErrorCode.FLAG_NOT_FOUND });
    expect(client.getBooleanDetails("release.anything", false).errorCode).toBe(
      ErrorCode.FLAG_NOT_FOUND,
    );
    expect(client.getBooleanDetails("__proto__", false).errorCode).toBe(
      ErrorCode.FLAG_NOT_FOUND,
    );
    const mismatch = client.getStringDetails(capabilityFlagKey(CONNECTORS), "dflt");
    expect(mismatch).toMatchObject({ value: "dflt", errorCode: ErrorCode.TYPE_MISMATCH });
    expect(client.getBooleanDetails(FLAG_GENERATION, false).errorCode).toBe(
      ErrorCode.TYPE_MISMATCH,
    );
    expect(client.getBooleanDetails(lifecycleFlagKey(CONNECTORS), false).errorCode).toBe(
      ErrorCode.TYPE_MISMATCH,
    );
    expect(client.getStringDetails(lifecycleFlagKey("nope.x"), "d").errorCode).toBe(
      ErrorCode.FLAG_NOT_FOUND,
    );
  });

  it("OF-03: `composition.plan` carries only the digest and approved ids", async () => {
    const plan = approvedPlan([CONNECTORS], FAMILY_POLICY);
    const store = storeDouble(readySnapshot(plan, 1));
    const { client } = await installCompositionProvider({ snapshotSource: store });
    // The default is empty on purpose: a flag that failed to resolve has no
    // keys and this assertion fails rather than matching the default's shape.
    const value = client.getObjectValue<Record<string, JsonValue>>(FLAG_PLAN, {});
    expect(Object.keys(value).sort()).toEqual(["approvedCapabilities", "planDigest"]);
    expect(JSON.stringify(value)).not.toContain(FAMILY_POLICY.instanceId);
    expect(JSON.stringify(value)).not.toContain("prohibited");
  });

  it("OF-06: late or repeated store events cannot restore an older generation's value", async () => {
    const enabled = approvedPlan([CONNECTORS]);
    const disabled = approvedPlan([]);
    const store = storeDouble(readySnapshot(enabled, 1));
    const { client } = await installCompositionProvider({ snapshotSource: store });
    const seen: number[] = [];
    client.addHandler(
      ProviderEvents.ConfigurationChanged,
      (details?: EventDetails<ProviderEvents.ConfigurationChanged>) => {
        expect(details?.flagsChanged).toContain(capabilityFlagKey(CONNECTORS));
        seen.push(client.getNumberValue(FLAG_GENERATION, -1));
      },
    );
    expect(client.getBooleanValue(capabilityFlagKey(CONNECTORS), false)).toBe(true);
    // Generation 2 lands without a notification, generation 3 with one, then
    // a stale notification for 2 is replayed.
    store.set(readySnapshot(disabled, 2), false);
    store.set(readySnapshot(disabled, 3));
    store.notify();
    store.notify();
    expect(seen).toEqual([3]);
    expect(client.getBooleanDetails(capabilityFlagKey(CONNECTORS), false)).toMatchObject({
      value: false,
      flagMetadata: { generation: 3 },
    });
  });

  it("OF-06: flagsChanged names exactly the flags whose values moved", () => {
    const store = storeDouble(readySnapshot(approvedPlan([]), 1));
    const provider = new LocalCompositionProvider(store);
    const changes: string[][] = [];
    provider.events.addHandler(
      ProviderEvents.ConfigurationChanged,
      (d?: EventDetails<ProviderEvents.ConfigurationChanged>) => {
        changes.push([...(d?.flagsChanged ?? [])]);
      },
    );
    void provider.initialize({});
    store.set(readySnapshot(approvedPlan([CONNECTORS]), 2));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain(FLAG_GENERATION);
    expect(changes[0]).toContain(FLAG_PLAN);
    expect(changes[0]).toContain(capabilityFlagKey(CONNECTORS));
    expect(changes[0]).toContain(lifecycleFlagKey(CONNECTORS));
    expect(changes[0]).not.toContain(capabilityFlagKey(TELEMETRY));
    // Same generation, same status: nothing is emitted.
    store.notify();
    expect(changes).toHaveLength(1);
  });

  it("OF-07: dispose and replacement both release the store subscription", async () => {
    const store = storeDouble(readySnapshot(approvedPlan([]), 1));
    const first = await installCompositionProvider({ snapshotSource: store });
    expect(store.listenerCount()).toBe(1);
    expect(first.provider.subscribed()).toBe(true);
    const second = await installCompositionProvider({ snapshotSource: store });
    await Promise.resolve();
    expect(first.provider.subscribed()).toBe(false);
    expect(second.provider.subscribed()).toBe(true);
    expect(store.listenerCount()).toBe(1);
    await second.dispose();
    expect(store.listenerCount()).toBe(0);
    expect(installedCompositionProvider()).toBeNull();
    await second.dispose();
    expect(store.listenerCount()).toBe(0);
  });

  it("OF-05: a foreign provider on our domain is detectable", async () => {
    await OpenFeature.setProviderAndWait(
      OPENFEATURE_DOMAIN,
      new InMemoryProvider({}),
    );
    expect(foreignProviderInstalled()).toBe(true);
    expect(installedCompositionProvider()).toBeNull();
    const store = storeDouble(readySnapshot(approvedPlan([]), 1));
    await installCompositionProvider({ snapshotSource: store });
    expect(foreignProviderInstalled()).toBe(false);
  });

  it("accepts only { vaultId } as context and retains nothing else", async () => {
    const store = storeDouble(readySnapshot(approvedPlan([]), 1));
    const { provider, client } = await installCompositionProvider({ snapshotSource: store });
    await OpenFeature.setContext(OPENFEATURE_DOMAIN, { vaultId: "personal" });
    expect(provider.context()).toEqual({ vaultId: "personal" });
    expect(() => projectedContext({ email: "a@b" })).toThrow(ErrorCode.INVALID_CONTEXT);
    expect(() => projectedContext({ vaultId: 3 })).toThrow(ErrorCode.INVALID_CONTEXT);
    await OpenFeature.setContext(OPENFEATURE_DOMAIN, { targetingKey: "u1", email: "a@b" });
    // The SDK records the refusal as an error state; nothing was retained and
    // evaluation still reads the store.
    expect(client.providerStatus).toBe(ProviderStatus.ERROR);
    expect(provider.context()).toEqual({ vaultId: "personal" });
    expect(client.getNumberValue(FLAG_GENERATION, -1)).toBe(1);
    // No telemetry hook and no provider hooks exist to smuggle context out.
    expect("track" in provider).toBe(false);
    expect("hooks" in provider).toBe(false);
  });
});
