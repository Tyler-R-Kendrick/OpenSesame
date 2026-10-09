import { generateVapidKeyPair } from "@opensesame/notification-adapters";
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { notificationChannelsFromEnv } from "../config-channels.js";
import { loadConfig } from "../config.js";
import { createControlPlane } from "../create-app.js";
import { authed, principal } from "./notification-kit.js";

/**
 * Which channels a deployment offers (ADR 0084), and when Web Push is one of
 * them. `OPENSESAME_NOTIFICATION_CHANNELS` defaults to the inbox alone, so a
 * working VAPID identity used to sit next to an effective route that called
 * `native_push` `adapter_unavailable`.
 */

const vapid = generateVapidKeyPair();
const stranger = generateVapidKeyPair();

const FULL = {
  OPENSESAME_WEBPUSH_PUBLIC_KEY: vapid.publicKey,
  OPENSESAME_WEBPUSH_PRIVATE_KEY: vapid.privateKey,
  OPENSESAME_WEBPUSH_SUBJECT: "mailto:ops@example.test",
};

describe("notificationChannelsFromEnv", () => {
  it("offers the inbox alone, and no key, when nothing is configured", () => {
    expect(notificationChannelsFromEnv({})).toEqual({
      availableChannels: ["in_app"],
      pushPublicKey: "",
    });
  });

  it("offers native_push when Web Push is fully configured, without it being listed", () => {
    expect(notificationChannelsFromEnv(FULL)).toEqual({
      availableChannels: ["in_app", "native_push"],
      pushPublicKey: vapid.publicKey,
    });
  });

  it("keeps the operator's other channels, in catalogue order, and lists push once", () => {
    const listed = notificationChannelsFromEnv({
      ...FULL,
      OPENSESAME_NOTIFICATION_CHANNELS: "slack, in_app",
    }).availableChannels;
    expect(listed.filter((kind) => kind === "native_push")).toHaveLength(1);
    expect(new Set(listed)).toEqual(
      new Set(["in_app", "slack", "native_push"]),
    );
    expect(
      notificationChannelsFromEnv({
        ...FULL,
        OPENSESAME_NOTIFICATION_CHANNELS: "in_app,native_push",
      }).availableChannels,
    ).toEqual(["in_app", "native_push"]);
  });

  it("stays honestly unavailable with only the public key, or nothing", () => {
    expect(
      notificationChannelsFromEnv({
        OPENSESAME_WEBPUSH_PUBLIC_KEY: vapid.publicKey,
      }),
    ).toEqual({
      availableChannels: ["in_app"],
      pushPublicKey: vapid.publicKey,
    });
  });

  it("lets a split deployment list native_push itself, with only the public key", () => {
    expect(
      notificationChannelsFromEnv({
        OPENSESAME_WEBPUSH_PUBLIC_KEY: vapid.publicKey,
        OPENSESAME_NOTIFICATION_CHANNELS: "in_app,native_push",
      }).availableChannels,
    ).toEqual(["in_app", "native_push"]);
  });

  it("refuses native_push with no public key to enrol under", () => {
    expect(() =>
      notificationChannelsFromEnv({
        OPENSESAME_NOTIFICATION_CHANNELS: "in_app,native_push",
      }),
    ).toThrow(/OPENSESAME_WEBPUSH_PUBLIC_KEY is not set/u);
  });

  it("refuses a private key that does not match, and a malformed public key", () => {
    expect(() =>
      notificationChannelsFromEnv({
        ...FULL,
        OPENSESAME_WEBPUSH_PRIVATE_KEY: stranger.privateKey,
      }),
    ).toThrow(/does not match/u);
    expect(() =>
      notificationChannelsFromEnv({ OPENSESAME_WEBPUSH_PUBLIC_KEY: "BPubKey" }),
    ).toThrow(/P-256/u);
    expect(() =>
      notificationChannelsFromEnv({
        ...FULL,
        OPENSESAME_WEBPUSH_SUBJECT: "",
      }),
    ).toThrow(/mailto: or https:/u);
  });
});

describe("the configuration loaded from the environment", () => {
  const base = {
    OPENSESAME_ENV: "test",
    OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
    OPENSESAME_PUBLIC_URL: "http://127.0.0.1:8788",
    OPENSESAME_ISSUER: "http://127.0.0.1:8788",
  };

  it("carries the channels and the key into the config", () => {
    const config = loadConfig({ ...base, ...FULL });
    expect(config.notifications.availableChannels).toContain("native_push");
    expect(config.notifications.pushPublicKey).toBe(vapid.publicKey);
    expect(loadConfig(base).notifications.availableChannels).toEqual([
      "in_app",
    ]);
  });

  it("refuses to start with a private key that is not the public key's", () => {
    expect(() =>
      loadConfig({
        ...base,
        ...FULL,
        OPENSESAME_WEBPUSH_PRIVATE_KEY: stranger.privateKey,
      }),
    ).toThrow(/does not match/u);
  });
});

describe("the effective route with Web Push configured", () => {
  async function effective(env: NodeJS.ProcessEnv) {
    const { app } = createControlPlane({
      processEnv: {
        OPENSESAME_ENV: "development",
        OPENSESAME_ALLOW_DEV_DEFAULTS: "1",
        ...env,
      },
    });
    const me = await principal(app);
    await app.request("/v1/notification-preferences", {
      method: "PUT",
      headers: authed(me.accessToken),
      body: JSON.stringify({
        byClass: {
          authorization_request: {
            channels: ["native_push", "in_app"],
            fanOut: false,
          },
        },
      }),
    });
    const res = await app.request("/v1/notification-preferences/effective", {
      headers: authed(me.accessToken),
    });
    return overlapCast(await res.json());
  }

  it("offers native_push as a step, not as adapter_unavailable", async () => {
    const plan = await effective(FULL);
    const kinds = plan.steps.map((step: { kind: string }) => step.kind);
    expect(kinds).toEqual(["native_push", "in_app"]);
    expect(
      plan.excluded.find((e: { kind: string }) => e.kind === "native_push"),
    ).toBeUndefined();
  });

  it("still reports adapter_unavailable with no VAPID configured", async () => {
    const plan = await effective({});
    expect(plan.steps.map((step: { kind: string }) => step.kind)).toEqual([
      "in_app",
    ]);
    expect(
      plan.excluded.find((e: { kind: string }) => e.kind === "native_push")
        ?.reason,
    ).toBe("adapter_unavailable");
  });
});
