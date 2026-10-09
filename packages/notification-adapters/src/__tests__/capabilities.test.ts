import {
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationChannelKind,
  channelCapabilities,
  defaultApprovalPolicy,
  normalizeApprovalPolicy,
} from "@opensesame/os-domain";
import { generateWebhookSecret } from "@opensesame/webhooks";
import { describe, expect, it } from "vitest";

import { createGenericWebhookAdapter } from "../adapters/generic-webhook.js";
import { createSlackAdapter } from "../adapters/slack.js";
import { createSmsAdapter } from "../adapters/sms.js";
import { createTeamsAdapter } from "../adapters/teams.js";
import { createTelegramAdapter } from "../adapters/telegram.js";
import {
  createWebPushAdapter,
  generateVapidKeyPair,
} from "../adapters/web-push.js";
import { createWeChatAdapter } from "../adapters/wechat.js";
import type { ChannelAdapter } from "../contract.js";
import { createAdapterRegistry } from "../registry.js";

const VAPID = generateVapidKeyPair();

function everyAdapter(): ChannelAdapter[] {
  return [
    createSlackAdapter({ botToken: "xoxb-t", signingSecret: "s" }),
    createTelegramAdapter({ botToken: "1:t", callbackSecretToken: "s" }),
    createTeamsAdapter({ webhookUrl: "https://teams.example/hook" }),
    createWeChatAdapter({ appId: "wx1", token: "t" }),
    createSmsAdapter({
      bridgeUrl: "https://bridge.example/send",
      bridgeSecret: generateWebhookSecret(),
    }),
    createWebPushAdapter({
      vapidPublicKey: VAPID.publicKey,
      vapidPrivateKey: VAPID.privateKey,
      vapidSubject: "mailto:ops@example.test",
    }),
    createGenericWebhookAdapter({}),
  ];
}

describe("capabilities come from the os-domain catalogue", () => {
  it("matches the catalogue entry for each adapter, field for field", () => {
    for (const adapter of everyAdapter()) {
      expect(adapter.capabilities()).toEqual(channelCapabilities(adapter.kind));
      expect(adapter.capabilities().kind).toBe(adapter.kind);
    }
  });

  it("covers every catalogue channel except the in-app inbox", () => {
    const covered = new Set(everyAdapter().map((adapter) => adapter.kind));
    const expected = NOTIFICATION_CHANNEL_KINDS.filter(
      (kind) => kind !== "in_app",
    );
    expect([...covered].sort()).toEqual([...expected].sort());
  });

  /**
   * The shape check that keeps the catalogue honest. A channel that declares
   * it can receive authenticated callbacks and ships no verifier would let a
   * policy admit a settlement path that does not exist; a channel that ships
   * one while declaring it cannot would be code nobody's policy can reach.
   */
  it("ships a callback verifier exactly where the catalogue says it can", () => {
    for (const adapter of everyAdapter()) {
      expect(adapter.verifyCallback !== undefined).toBe(
        adapter.capabilities().canReceiveAuthenticatedCallback,
      );
    }
  });

  it("returns a decision only from channels that can render one", () => {
    for (const adapter of everyAdapter()) {
      if (adapter.capabilities().canRenderDecisionActions) continue;
      // wechat is the interesting case: it can verify a callback and can
      // never mean a decision by it.
      const verified = adapter.verifyCallback?.({
        rawBody: new Uint8Array(),
        headers: {},
      });
      expect(verified?.ok ?? false).toBe(false);
    }
  });

  it("never claims phishing resistance on any external channel", () => {
    for (const adapter of everyAdapter()) {
      expect(adapter.capabilities().canSatisfyPhishingResistance).toBe(false);
    }
  });
});

describe("the registry reports what is actually configured", () => {
  it("always offers the in-app inbox and nothing else by default", () => {
    const registry = createAdapterRegistry({});
    expect(registry.availableChannels()).toEqual(["in_app"]);
    expect(registry.adapters).toHaveLength(0);
  });

  it("lists a channel only once its configuration is complete", () => {
    const halfConfigured = createAdapterRegistry({
      slack: { botToken: "xoxb-t", signingSecret: "" },
      telegram: { botToken: "1:t", callbackSecretToken: "s" },
    });
    expect(halfConfigured.availableChannels()).toEqual(["in_app", "telegram"]);
    expect(halfConfigured.get("slack")?.isConfigured()).toBe(false);
  });

  it("returns channels in catalogue order, whatever order they were built in", () => {
    const registry = createAdapterRegistry({
      webhook: {},
      slack: { botToken: "xoxb-t", signingSecret: "s" },
      teams: { webhookUrl: "https://teams.example/hook" },
    });
    expect(registry.availableChannels()).toEqual([
      "in_app",
      "slack",
      "teams",
      "webhook",
    ]);
  });

  it("hands back the adapter for a configured kind and nothing for the rest", () => {
    const registry = createAdapterRegistry({
      slack: { botToken: "xoxb-t", signingSecret: "s" },
    });
    expect(registry.get("slack")?.kind).toBe("slack");
    expect(registry.get("wechat")).toBeUndefined();
    expect(registry.get("in_app")).toBeUndefined();
  });

  /**
   * The composition the domain performs. A policy that names every channel
   * as a direct-approval channel is normalized down to the ones whose
   * capabilities can actually mean it — and the registry decides which of
   * those a deployment even has.
   *
   * `in_app` is not in the survivors, and that is the domain's rule rather
   * than an omission here: `normalizeApprovalPolicy` requires
   * `bindsExternalIdentity`, which the inbox does not have because it binds
   * an OpenSesame principal instead of a provider subject. "Direct
   * settlement" in this vocabulary means *external* direct settlement.
   */
  it("feeds a policy normalization that keeps only settleable channels", () => {
    const settleable: NotificationChannelKind[] = [
      ...NOTIFICATION_CHANNEL_KINDS,
    ];
    const normalized = normalizeApprovalPolicy({
      ...defaultApprovalPolicy("low"),
      directApprovalChannels: settleable,
      directDenialChannels: settleable,
    });
    expect(normalized.directApprovalChannels.sort()).toEqual([
      "slack",
      "telegram",
    ]);
    for (const kind of normalized.directApprovalChannels) {
      if (kind === "in_app") continue;
      const adapter = everyAdapter().find((entry) => entry.kind === kind);
      expect(adapter?.verifyCallback).toBeDefined();
    }
  });
});
