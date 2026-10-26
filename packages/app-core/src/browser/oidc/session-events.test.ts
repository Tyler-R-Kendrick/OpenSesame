/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { advanceAuthGeneration } from "../../lib/auth-generation.js";
import {
  advanceFederationSessionGeneration,
  federationSessionGeneration,
  readNativeFederationSession,
} from "../../lib/federation-native-session.js";
import {
  notifyFederationSessionChanged,
  subscribeFederationSession,
} from "../../lib/federation-session-events.js";
import { readFederationSessionJson } from "../../lib/federation-session-store.js";
import { clearSession } from "../../lib/federation.js";
import { getIdentityConnectionRuntime } from "../../lib/identity-connections-store.js";
import { captureNativeIdentityOwner } from "../../lib/identity-native-owner.js";
import { fixture } from "../../lib/origin-file-publication-custody.test-support.js";
import { protocol, runtime, saveAdapter } from "./oidc.test-support.js";

async function genuine() {
  fixture();
  const p = await protocol();
  const { draft, connection } = await saveAdapter(p.idp);
  const saved = getIdentityConnectionRuntime(connection.connectionId);
  if (!saved) throw new Error("Missing genuine saved connection");
  const owner = captureNativeIdentityOwner(connection.connectionId, "oidc");
  owner.bindConfiguration(saved);
  const activations: ReturnType<typeof runtime>[] = [];
  owner.prepareRuntime(() => {
    activations.push(runtime());
  });
  const selected = activations[0];
  if (!selected) throw new Error("Missing original admission runtime");
  const proof = await p.complete();
  return {
    p,
    owner,
    draft,
    publish: () =>
      selected.admit(proof, {
        connectionId: connection.connectionId,
        label: draft.name,
        assertSessionCurrent: (claims) =>
          owner.assertSessionCurrent(claims.issuer, claims.audience),
        releaseSession: owner.release,
      }),
  };
}
it.each(["clear", "withdrawal", "expiry"])(
  "void presentation events follow genuine native publication and %s",
  async (mode) => {
    const actual = await genuine();
    const observed: (string | null)[] = [];
    const listener = vi.fn(() => {
      observed.push(readNativeFederationSession()?.pairwiseSub ?? null);
    });
    const unsubscribe = subscribeFederationSession(listener);
    if (mode === "expiry")
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      await actual.publish();
      await Promise.resolve();
      expect(observed.at(-1)).toBe("owned-person");
      expect(listener).toHaveBeenLastCalledWith();
      if (mode === "clear") clearSession();
      else if (mode === "withdrawal") advanceAuthGeneration();
      else await vi.advanceTimersByTimeAsync(121000);
      await Promise.resolve();
      expect(observed.at(-1)).toBeNull();
      expect(readNativeFederationSession()).toBeNull();
      expect(actual.owner.signal.aborted).toBe(true);
      expect(readFederationSessionJson()).toBeNull();
      expect(actual.p.idp.errors).toEqual([]);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  },
);
it("presentation delivery cannot synchronously reenter an opaque generation transition", async () => {
  let clear = true;
  const unsubscribe = subscribeFederationSession(() => {
    if (clear) {
      clear = false;
      advanceFederationSessionGeneration();
    }
  });
  try {
    const published = advanceFederationSessionGeneration();
    expect(federationSessionGeneration()).toBe(published);
    await Promise.resolve();
    expect(federationSessionGeneration()).not.toBe(published);
    expect(Object.isFrozen(published)).toBe(true);
  } finally {
    unsubscribe();
  }
});
it("coalesced presentation invalidation carries no authority and honors unsubscribe", async () => {
  const listener = vi.fn();
  const before = federationSessionGeneration();
  const unsubscribe = subscribeFederationSession(listener);
  notifyFederationSessionChanged();
  notifyFederationSessionChanged();
  expect(listener).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledExactlyOnceWith();
  expect(federationSessionGeneration()).toBe(before);
  notifyFederationSessionChanged();
  unsubscribe();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
});
