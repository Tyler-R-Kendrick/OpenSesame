import {
  modelMemoryBackend,
  saveModelFixture,
} from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import {
  type NativeConnectorDriver,
  registerNativeConnectorDriver,
} from "@opensesame/app-core/lib/native-connector-drivers.js";
import type { NativeMethod } from "@opensesame/app-core/lib/native-connector-schema.js";
import {
  readNativeConnector,
  updateNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeConnectorController } from "./native-connector-controller.js";

const providerId = "controller-fixture";
const classification = {
  publicParameters: [],
  privateCredentials: ["api_key"],
};
const disposers: (() => void)[] = [];
async function fixture(method: NativeMethod) {
  const id = await saveModelFixture(providerId);
  const initial = readNativeConnector(id);
  if (!initial) throw new Error("Missing controller fixture");
  return updateNativeConnector(id, initial, classification, (record) => {
    record.configuration.method = method;
    const grant = record.privateState.grants.app;
    if (!grant) throw new Error("Missing fixture grant");
    grant.kind = method;
    if (method === "mcp")
      Object.assign(grant, {
        issuer: "https://issuer.example.org",
        resource: "https://mcp.example.org",
        endpoint: "https://mcp.example.org/mcp",
        clientId: "public-client",
      });
    record.privateState.verification = {
      fingerprint: initial.fingerprint,
      verifiedAt: 101,
      kind: "provider",
    };
    record.runtime.verifiedAt = 101;
    return record;
  });
}
beforeEach(() => {
  kvForgetAll();
  modelMemoryBackend();
});
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
});

it.each(["api-key", "oauth", "mcp"] as const)(
  "dispatches %s configuration, verification, authorization and operations using the saved binding",
  async (method) => {
    const saved = await fixture(method);
    const configure = vi.fn<NativeConnectorDriver["configure"]>(
      async () => saved,
    );
    const verify = vi.fn<NativeConnectorDriver["verify"]>(async () => saved);
    const authorize = vi.fn(async () => {});
    const invoke = vi.fn<NativeConnectorDriver["invoke"]>(async () => ({
      label: "Safe result",
      items: [],
    }));
    disposers.push(
      registerNativeConnectorDriver(method, {
        supports: (id) => id === providerId,
        configure,
        verify,
        authorize,
        invoke,
        cleanup: {
          classification: () => classification,
          cleanup: async () => "local-credential-forgotten",
        },
      }),
    );
    const controller = nativeConnectorController(
      { id: providerId, refused: false },
      saved.connectionId,
    );
    expect(controller.load()?.status).toBe("connected");
    await controller.configure({
      method,
      displayName: "Updated",
      parameters: {},
      credentials: { api_key: "new-private-input" },
      requestedScopes: {},
      targetIds: {},
    });
    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId,
        connectionId: saved.connectionId,
        revision: saved.revision,
        method,
      }),
    );
    expect(controller.load()).toEqual(saved);
    await controller.verify();
    expect(verify).toHaveBeenCalledWith(saved.connectionId);
    await controller.authorize?.("app");
    expect(authorize).toHaveBeenCalledWith(saved.connectionId, "app");
    await controller.invoke("provider.read", { limit: "3" });
    expect(invoke).toHaveBeenCalledWith(saved.connectionId, "provider.read", {
      limit: "3",
    });
  },
);

it("rejects a stale rendered revision until the user loads the current saved state", async () => {
  const saved = await fixture("oauth");
  const verify = vi.fn<NativeConnectorDriver["verify"]>(async () => {
    const view = readNativeConnector(saved.connectionId);
    if (!view) throw new Error("Missing controller fixture");
    return view;
  });
  disposers.push(
    registerNativeConnectorDriver("oauth", {
      supports: (id) => id === providerId,
      verify,
      configure: async () => saved,
      invoke: async () => ({ label: "Safe", items: [] }),
      cleanup: {
        classification: () => classification,
        cleanup: async () => "local-credential-forgotten",
      },
    }),
  );
  const controller = nativeConnectorController(
    { id: providerId, refused: false },
    saved.connectionId,
  );
  controller.load();
  await updateNativeConnector(
    saved.connectionId,
    saved,
    classification,
    (record) => {
      record.configuration.displayName = "Edited in another tab";
      return record;
    },
  );
  await expect(controller.verify()).rejects.toThrow("reload and review");
  expect(verify).not.toHaveBeenCalled();
  controller.load();
  await controller.verify();
  expect(verify).toHaveBeenCalledOnce();
});

it("rejects a connection from another provider and a method switch on a saved connection", async () => {
  const saved = await fixture("oauth");
  const other = nativeConnectorController(
    { id: "other-provider", refused: false },
    saved.connectionId,
  );
  expect(() => other.load()).toThrow("another provider");
  const controller = nativeConnectorController(
    { id: providerId, refused: false },
    saved.connectionId,
  );
  controller.load();
  await expect(
    controller.configure({
      method: "mcp",
      displayName: "Wrong method",
      parameters: {},
      credentials: {},
      requestedScopes: {},
      targetIds: {},
    }),
  ).rejects.toThrow("another authorization method");
});
