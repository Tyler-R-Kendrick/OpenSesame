import {
  NOW,
  bootPersonalLocal,
  draftFor,
  durable,
  freshRealm,
} from "@opensesame/app-core/lib/capabilities/__tests__/harness.js";
import { FAMILY_POLICY } from "@opensesame/app-core/lib/capabilities/__tests__/plan-fixtures.js";
import { LOCAL_POLICY_KEY } from "@opensesame/app-core/lib/capabilities/keys.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { nativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import {
  FIXTURE_CATALOG,
  buildConsentReceipt,
  fixtureResolveInput,
  resolveComposition,
} from "@opensesame/capability-composition";
import { afterEach, expect, it, vi } from "vitest";
import {
  KEY,
  activate,
  audio,
  providerFixture,
} from "./native-deepgram-websocket.test-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  compositionStore.resetForTest();
});

async function held(
  owner: ReturnType<typeof activate>,
  fixture: Awaited<ReturnType<typeof providerFixture>>,
  signal: AbortSignal,
) {
  const open = owner.transport.openWebSocket;
  if (!open) throw new Error("Actual native socket binding missing");
  const requestedUrl = new URL("wss://api.deepgram.com/v1/listen?model=nova-3");
  const channel = open(requestedUrl, ["token", KEY], signal);
  await expect.poll(() => channel.socket.readyState).toBe(1);
  const before = fixture.controls.length;
  channel.socket.send(audio().blob);
  channel.socket.send(JSON.stringify({ type: "Finalize" }));
  channel.socket.send(JSON.stringify({ type: "CloseStream" }));
  await expect.poll(() => fixture.controls.length).toBe(before + 2);
  return { ...channel, requestedUrl };
}

it.each(["lease", "dispose", "caller", "replacement"] as const)(
  "physically closes only the original held WSS socket on %s withdrawal",
  async (reason) => {
    const fixture = await providerFixture();
    const owner = activate(fixture);
    const caller = new AbortController();
    const laterCaller = new AbortController();
    try {
      fixture.setMode("held");
      const first = await held(owner, fixture, caller.signal);
      let later: Awaited<ReturnType<typeof held>> | undefined;
      if (reason === "replacement")
        later = await held(activate(fixture), fixture, laterCaller.signal);
      if (reason === "caller") caller.abort();
      else if (reason === "dispose") owner.activation.dispose();
      else owner.test.abort();
      await expect.poll(fixture.closed).toBe(1);
      expect(() => first.assertCurrent()).toThrow();
      expect(() =>
        owner.transport.openWebSocket?.(
          new URL("wss://api.deepgram.com/v1/listen"),
          ["token", KEY],
          caller.signal,
        ),
      ).toThrow();
      if (later) {
        later.assertCurrent();
        expect(later.socket.readyState).toBe(1);
        nativeProviderTransport().assertCurrent();
        laterCaller.abort();
        await expect.poll(fixture.closed).toBe(2);
      }
      expect(fixture.peers.size).toBe(0);
    } finally {
      caller.abort();
      laterCaller.abort();
      owner.activation.dispose();
      await fixture.close();
    }
  },
);

it.each(["origin", "external-services"] as const)(
  "closes an idle socket on actual %s policy publication while its original lease stays live",
  async (reason) => {
    freshRealm();
    const policy = {
      ...FAMILY_POLICY,
      instanceId: "personal-local",
      network: {
        externalServices: "allow" as const,
        allowedServiceOrigins: ["wss://api.deepgram.com"],
      },
    };
    durable.set(LOCAL_POLICY_KEY, JSON.stringify(policy));
    await bootPersonalLocal();
    const draft = {
      ...draftFor(compositionStore, ["connectors.external"], "socket-selection")
        .draft,
      acceptedRequired: [...policy.capabilities.required],
    };
    const receipt = buildConsentReceipt(
      resolveComposition(
        fixtureResolveInput({
          installation: draft,
          instancePolicy: policy,
          provenance: "personal-local",
        }),
      ),
      FIXTURE_CATALOG,
      NOW,
    );
    expect(await compositionStore.commit(draft, receipt)).toMatchObject({
      status: "committed",
    });
    const plan = () => compositionStore.getSnapshot().plan;
    expect(plan()?.capabilities["connectors.external"]?.reasons).toEqual([]);
    expect(plan()?.capabilities["connectors.external"]?.approved).toBe(true);
    const fixture = await providerFixture();
    const owner = activate(fixture, plan);
    const caller = new AbortController();
    try {
      fixture.setMode("held");
      const channel = await held(owner, fixture, caller.signal);
      channel.requestedUrl.hostname = "other.example";
      compositionStore.setActivity("connectors.external", "active");
      expect(channel.socket.readyState).toBe(1);
      expect(fixture.closed()).toBe(0);
      const network =
        reason === "origin"
          ? {
              externalServices: "allow",
              allowedServiceOrigins: ["https://api.deepgram.com"],
            }
          : { externalServices: "deny", allowedServiceOrigins: [] };
      durable.set(LOCAL_POLICY_KEY, JSON.stringify({ ...policy, network }));
      compositionStore.invalidate("actual-network-policy-write");
      expect(plan()?.capabilities["connectors.external"]?.approved).toBe(true);
      expect(owner.test.ctx.lease.signal.aborted).toBe(false);
      owner.transport.assertCurrent();
      await expect.poll(fixture.closed).toBe(1);
      expect(() => channel.assertCurrent()).toThrow();
      expect(fixture.peers.size).toBe(0);
      durable.set(LOCAL_POLICY_KEY, JSON.stringify(policy));
      compositionStore.invalidate("actual-network-policy-restore");
      expect(plan()?.capabilities["connectors.external"]?.approved).toBe(true);
      expect(() => channel.assertCurrent()).toThrow();
    } finally {
      caller.abort();
      owner.activation.dispose();
      await fixture.close();
    }
  },
);
