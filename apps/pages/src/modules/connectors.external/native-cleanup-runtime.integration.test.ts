import { modelMemoryBackend } from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import {
  type NativeConnectorDriver,
  registerNativeConnectorDriver,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import {
  type NativeProviderCleanup,
  removeNativeConnectorWithCleanup,
} from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import {
  emptyNativePrivate,
  emptyNativeRuntime,
} from "@opensesame/app-core/lib/native-connector-schema.js";
import {
  readNativeConnector,
  saveNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { bindNativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeConnectorController } from "../../sections/connections/connect/native-connector-controller.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindNativeCleanupRuntime } from "./native-cleanup-runtime.js";

const providerId = "multimethod-fixture";
const fingerprint = "f".repeat(64);
const classification = {
  publicParameters: [],
  privateCredentials: ["api_key", "clientSecret", "mcp_client", "mcp_target"],
};
const disposers: (() => void)[] = [];
function testDriver(cleanup: NativeProviderCleanup): NativeConnectorDriver {
  return {
    supports: (id) => id === providerId,
    cleanup,
    configure: async () => {
      throw new Error("Unused fixture operation");
    },
    verify: async () => {
      throw new Error("Unused fixture operation");
    },
    invoke: async () => {
      throw new Error("Unused fixture operation");
    },
  };
}
beforeEach(() => {
  kvForgetAll();
  modelMemoryBackend();
});
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
});

it("prepares the selected method and dispatches an old grant to its original method with only that method's slots", async () => {
  const test = createTestContext();
  const activation = createActivation(test.ctx, "connectors.external");
  disposers.push(activation.dispose);
  disposers.push(
    bindNativeProviderTransport({
      fetch: vi.fn(),
      assertCurrent: () => {
        if (activation.disposed()) throw new Error("Expired activation");
      },
    }),
  );
  const oauthPrepare = vi.fn(async () => {});
  const mcpPrepare = vi.fn(async () => {});
  const oauthCleanup = vi.fn<NativeProviderCleanup["cleanup"]>(
    async (obligation) => {
      expect(obligation.grant?.kind).toBe("oauth");
      expect(obligation.credentials).toEqual({
        clientSecret: "private-oauth-client",
      });
      return "local-credential-forgotten";
    },
  );
  const mcpCleanup = vi.fn<NativeProviderCleanup["cleanup"]>(
    async (obligation) => {
      expect(obligation.kind).toBe("registration");
      expect(obligation.credentials).toEqual({
        mcp_client: "private-mcp-client",
      });
      return "provider-revoked";
    },
  );
  activation.onDispose(
    registerNativeConnectorDriver(
      "oauth",
      testDriver({
        classification: () => classification,
        credentialSlots: ["clientSecret"],
        prepare: oauthPrepare,
        cleanup: oauthCleanup,
      }),
    ),
  );
  activation.onDispose(
    registerNativeConnectorDriver(
      "mcp",
      testDriver({
        classification: () => classification,
        credentialSlots: () => ["mcp_client", "mcp_target"],
        prepare: mcpPrepare,
        cleanup: mcpCleanup,
      }),
    ),
  );
  bindNativeCleanupRuntime(activation, [providerId]);
  const saved = await saveNativeConnector(
    {
      connectionId: "multimethod-connection",
      configuration: {
        version: 1,
        providerId,
        method: "mcp",
        displayName: "Mixed authorization",
        icon: "",
        parameters: {},
        requestedScopes: {},
        targetIds: {},
        fingerprint,
      },
      runtime: emptyNativeRuntime(),
      privateState: {
        ...emptyNativePrivate(),
        credentials: {
          api_key: "unrelated-key",
          clientSecret: "private-oauth-client",
          mcp_client: "private-mcp-client",
          mcp_target: "private-mcp-target",
        },
        grants: {
          user: {
            providerId,
            actor: "user",
            fingerprint,
            kind: "oauth",
            accessToken: "old-private-oauth-access",
            expiresAt: null,
            scopes: null,
            targetId: "old-account",
          },
        },
        recovery: [
          {
            id: "mcp-registration",
            kind: "registration",
            providerId,
            actor: "user",
            fingerprint,
            targetId: "client-1",
            credentials: { mcp_client: "private-mcp-client" },
          },
        ],
      },
    },
    classification,
  );
  const controller = nativeConnectorController(
    { id: providerId, refused: false },
    saved.connectionId,
  );
  controller.load();
  await controller.remove();
  expect(mcpPrepare).toHaveBeenCalledOnce();
  expect(oauthPrepare).not.toHaveBeenCalled();
  expect(mcpCleanup).toHaveBeenCalledOnce();
  expect(oauthCleanup).toHaveBeenCalledOnce();
  expect(readNativeConnector(saved.connectionId)).toBeNull();
});

it("refuses guarded removal when provider cleanup remains unresolved", async () => {
  const test = createTestContext();
  const activation = createActivation(test.ctx, "connectors.external");
  disposers.push(activation.dispose);
  disposers.push(
    bindNativeProviderTransport({ fetch: vi.fn(), assertCurrent: () => {} }),
  );
  activation.onDispose(
    registerNativeConnectorDriver(
      "mcp",
      testDriver({
        classification: () => classification,
        cleanup: async () => "local-credential-forgotten",
      }),
    ),
  );
  bindNativeCleanupRuntime(activation, [providerId]);
  const saved = await saveNativeConnector(
    {
      connectionId: "unresolved-registration",
      configuration: {
        version: 1,
        providerId,
        method: "mcp",
        displayName: "Registration",
        icon: "",
        parameters: {},
        requestedScopes: {},
        targetIds: {},
        fingerprint,
      },
      runtime: emptyNativeRuntime(),
      privateState: {
        ...emptyNativePrivate(),
        recovery: [
          {
            id: "remote-client",
            kind: "registration",
            providerId,
            actor: "user",
            fingerprint,
            targetId: "client-1",
          },
        ],
      },
    },
    classification,
  );
  await expect(
    removeNativeConnectorWithCleanup(saved.connectionId),
  ).rejects.toThrow("Provider cleanup failed");
  expect(readNativeConnector(saved.connectionId)?.status).toBe("cleanup");
  expect(readNativeConnector(saved.connectionId)?.recovery[0]?.id).toBe(
    "remote-client",
  );
});
