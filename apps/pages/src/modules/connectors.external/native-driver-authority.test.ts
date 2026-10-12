import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { installNativeApiTests } from "@opensesame/app-core/lib/native-api.test-support.js";
// @vitest-environment jsdom
import {
  type NativeDriverInput,
  nativeConnectorDriver,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import type {
  NativeConfiguration,
  NativeRecovery,
} from "@opensesame/app-core/lib/native-connector-schema.js";
import { describe, expect, it } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindNativeApiRuntime } from "./native-api-runtime.js";
import { bindNativeOAuthRuntime } from "./native-oauth-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";

installNativeApiTests();
function activate(generation: number) {
  const test = createTestContext({
    generation,
    egressResponse: () => Response.json({ name: "Team", id: "bot-1" }),
  });
  const activation = createActivation(test.ctx, "connectors.external");
  try {
    bindNativeRuntime(test.ctx, activation);
    bindNativeApiRuntime(activation);
    bindNativeOAuthRuntime(activation);
  } catch (error) {
    activation.dispose();
    throw error;
  }
  return { ...test, activation };
}
function input(
  method: "api-key" | "oauth" | "mcp",
  providerId: string,
): NativeDriverInput {
  return {
    providerId,
    method,
    displayName: "Team",
    icon: "",
    parameters:
      providerId === "vault"
        ? { endpoint: "https://vault.example.test", namespace: "" }
        : method === "oauth"
          ? { client_id: "public-native-client" }
          : {},
    credentials: method === "api-key" ? { api_key: "private-native-key" } : {},
    requestedScopes: {},
    targetIds: {},
  };
}
describe("captured native driver authority", () => {
  it.each([
    ["api-key", "notion"],
    ["api-key", "vault"],
    ["oauth", "gitlab"],
    ["mcp", "notion"],
  ] as const)(
    "refuses every old %s/%s operation after disposal and reactivation",
    async (method, providerId) => {
      const old = activate(1);
      const held = nativeConnectorDriver(method, providerId);
      old.activation.dispose();
      const current = activate(2);
      try {
        const configuration: NativeConfiguration = {
          version: 1,
          providerId,
          method,
          displayName: "Team",
          icon: "",
          parameters: {},
          requestedScopes: {},
          targetIds: {},
          fingerprint: "b".repeat(64),
        };
        const obligation: NativeRecovery = {
          id: "revoke:user",
          kind: "revoke",
          providerId,
          actor: "user",
          fingerprint: configuration.fingerprint,
          targetId: "target-1",
          grant: {
            providerId,
            actor: "user",
            kind: method,
            fingerprint: configuration.fingerprint,
            targetId: "target-1",
            accessToken: "private-token",
            scopes: [],
            expiresAt: null,
          },
        };
        await expect(async () =>
          held.configure(input(method, providerId)),
        ).rejects.toThrow();
        await expect(async () =>
          held.verify("old-connection"),
        ).rejects.toThrow();
        await expect(async () =>
          held.invoke(
            "old-connection",
            method === "mcp" ? "mcp.tools.list" : "provider.read",
            {},
          ),
        ).rejects.toThrow();
        if (held.authorize)
          await expect(async () =>
            held.authorize?.("old-connection", "user"),
          ).rejects.toThrow();
        expect(() => held.cleanup.classification(configuration)).toThrow();
        const slots = held.cleanup.credentialSlots;
        if (slots && "call" in slots)
          expect(() => slots(configuration, obligation.grant)).toThrow();
        if (held.cleanup.prepare)
          await expect(async () =>
            held.cleanup.prepare?.("old-connection"),
          ).rejects.toThrow();
        await expect(async () =>
          held.cleanup.cleanup(obligation, {
            connectionId: "old-connection",
            configuration,
            persistGrantRotation: async () => {
              throw new Error("No stale grant rotation");
            },
          }),
        ).rejects.toThrow();
        expect(old.egressCalls).toEqual([]);
        expect(current.egressCalls).toEqual([]);
        expect(readDeviceRows()).toEqual([]);
        if (method === "api-key" && providerId === "notion") {
          const fresh = await nativeConnectorDriver(
            method,
            providerId,
          ).configure(input(method, providerId));
          expect(fresh.status).toBe("connected");
          expect(current.egressCalls).toHaveLength(1);
        }
      } finally {
        current.activation.dispose();
      }
    },
  );
});
