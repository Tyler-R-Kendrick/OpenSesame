import { overlapCast } from "@opensesame/os-domain";
import { expect } from "vitest";
import type { ControlPlaneConfig } from "../config.js";
import { createControlPlane } from "../create-app.js";

/** Shared setup for the notification channel suites. */
export type Notifications = ControlPlaneConfig["notifications"];

export function notifications(
  overrides: Partial<Notifications> = {},
): Notifications {
  return {
    availableChannels: ["in_app", "slack"],
    directApprovalChannels: [],
    directDenialChannels: [],
    pushPublicKey: "",
    slackSigningSecret: "",
    telegramSecretToken: "",
    allowSelfAssertedBindings: true,
    ...overrides,
  };
}

export interface PlaneOptions {
  clock?: () => Date;
  notifications?: Partial<Notifications>;
}

export function plane(options?: PlaneOptions) {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      notifications: notifications(options?.notifications),
    },
    ...(options?.clock ? { clock: options.clock } : undefined),
  });
}

export type App = ReturnType<typeof createControlPlane>["app"];

export async function principal(app: App) {
  const res = await app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

export function authed(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}
