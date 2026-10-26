import {
  protocol,
  runtime,
  saveAdapter,
} from "@opensesame/app-core/browser/oidc/oidc.test-support.js";
import { advanceAuthGeneration } from "@opensesame/app-core/lib/auth-generation.js";
import { readNativeFederationSession } from "@opensesame/app-core/lib/federation-native-session.js";
import { readFederationSessionJson } from "@opensesame/app-core/lib/federation-session-store.js";
import { clearSession } from "@opensesame/app-core/lib/federation.js";
import { getIdentityConnectionRuntime } from "@opensesame/app-core/lib/identity-connections-store.js";
import { captureNativeIdentityOwner } from "@opensesame/app-core/lib/identity-native-owner.js";
import { fixture } from "@opensesame/app-core/lib/origin-file-publication-custody.test-support.js";
/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAccount } from "./account.js";

afterEach(cleanup);
async function genuine() {
  fixture();
  const p = await protocol();
  const { draft, connection } = await saveAdapter(p.idp);
  const saved = getIdentityConnectionRuntime(connection.connectionId);
  if (!saved) throw new Error("Missing genuine saved configuration");
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
  "same-tab account follows genuine native publication and %s without storage notifications",
  async (mode) => {
    const actual = await genuine();
    const hook = renderHook(() => useAccount());
    const original = hook.result.current;
    if (mode === "expiry")
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      await act(async () => {
        await actual.publish();
      });
      expect(hook.result.current).toMatchObject({
        name: actual.draft.name,
        guest: false,
      });
      expect(readNativeFederationSession()?.pairwiseSub).toBe("owned-person");
      expect(readFederationSessionJson()).toBeNull();
      await act(async () => {
        if (mode === "clear") clearSession();
        else if (mode === "withdrawal") advanceAuthGeneration();
        else await vi.advanceTimersByTimeAsync(121000);
      });
      expect(hook.result.current).toEqual(original);
      expect(readNativeFederationSession()).toBeNull();
      expect(actual.p.idp.errors).toEqual([]);
    } finally {
      hook.unmount();
      vi.useRealTimers();
    }
  },
);
