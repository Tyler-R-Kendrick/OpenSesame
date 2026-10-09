import { deviceProviderRevokers } from "@opensesame/app-core/lib/device-connectors.js";
import { modelMemoryBackend } from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeConnectorController } from "../../sections/connections/connect/native-connector-controller.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindNativeApiRuntime } from "./native-api-runtime.js";
import { bindNativeCleanupRuntime } from "./native-cleanup-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";

const token = "private-vault-integration-token";
const input = {
  providerId: "vault",
  method: "api-key" as const,
  displayName: "My Vault",
  icon: "",
  parameters: {
    endpoint: "https://vault.example.org",
    namespace: "engineering",
  },
  credentials: { api_key: token },
  requestedScopes: {},
  targetIds: {},
};
const disposers: (() => void)[] = [];
function activate() {
  const test = createTestContext();
  const fetcher = vi.fn<typeof test.ctx.egress.fetch>(async () =>
    Response.json({
      data: {
        id: token,
        accessor: "private-accessor",
        entity_id: "entity-1",
        display_name: "Engineering",
        policies: ["engineering-read"],
        ttl: 3600,
        renewable: true,
      },
    }),
  );
  const ctx = { ...test.ctx, egress: { ...test.ctx.egress, fetch: fetcher } };
  const activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  bindNativeApiRuntime(activation);
  bindNativeCleanupRuntime(activation, ["vault", "openbao"]);
  disposers.push(activation.dispose);
  return { activation, fetcher };
}
beforeEach(() => {
  kvForgetAll();
  modelMemoryBackend();
});
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
});

it.each(["vault", "openbao"])(
  "configures, retains, verifies, reads and disconnects %s through the actual controller and runtime",
  async (providerId) => {
    const { fetcher } = activate();
    const controller = nativeConnectorController({
      id: providerId,
      refused: false,
    });
    const saved = await controller.configure({ ...input });
    expect(saved.providerId).toBe(providerId);
    expect(saved.status).toBe("connected");
    expect(controller.load()?.connectionId).toBe(saved.connectionId);
    const retained = await controller.configure({
      ...input,
      displayName: "Renamed",
      credentials: {},
    });
    expect(retained.status).toBe("connected");
    expect(retained.connectionId).toBe(saved.connectionId);
    expect(
      new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("X-Vault-Token"),
    ).toBe(token);
    const verified = await controller.verify();
    expect(verified.status).toBe("connected");
    const result = await controller.invoke("provider.read", {});
    expect(result.items).toEqual([
      { id: "engineering-read", label: "engineering-read" },
    ]);
    expect(JSON.stringify({ saved, retained, verified, result })).not.toContain(
      token,
    );
    const calls = fetcher.mock.calls.length;
    await controller.remove();
    expect(controller.load()).toBeNull();
    expect(readNativeConnector(saved.connectionId)).toBeNull();
    expect(fetcher.mock.calls.length).toBe(calls);
  },
);

it("rejects unknown scopes, targets, fields and operations before credential egress", async () => {
  const { fetcher } = activate();
  const driver = nativeConnectorDriver("api-key", "vault");
  for (const changed of [
    { requestedScopes: { app: ["invented"] } },
    { targetIds: { workspace: "invented" } },
    { parameters: { ...input.parameters, unexpected: "value" } },
    { credentials: { ...input.credentials, other_secret: "private" } },
  ])
    await expect(async () =>
      driver.configure({ ...input, ...changed }),
    ).rejects.toThrow("provider instance");
  expect(fetcher).not.toHaveBeenCalled();
  const saved = await driver.configure(input);
  const calls = fetcher.mock.calls.length;
  await expect(
    driver.invoke(saved.connectionId, "provider.delete", {}),
  ).rejects.toThrow("supported provider operation");
  await expect(
    driver.invoke(saved.connectionId, "provider.read", { unexpected: "value" }),
  ).rejects.toThrow("supported provider operation");
  expect(fetcher.mock.calls.length).toBe(calls);
});

it("retained old instance drivers and revokers refuse to borrow a new capability activation", async () => {
  const old = activate();
  const driver = nativeConnectorDriver("api-key", "vault");
  const saved = await driver.configure(input);
  const revoke = deviceProviderRevokers.vault;
  if (!revoke) throw new Error("Missing revoker fixture");
  old.activation.dispose();
  const fresh = activate();
  expect(() => driver.configure(input)).toThrow();
  expect(() => driver.verify(saved.connectionId)).toThrow();
  await expect(
    driver.invoke(saved.connectionId, "provider.read", {}),
  ).rejects.toThrow();
  await expect(revoke(saved.connectionId)).rejects.toThrow();
  expect(fresh.fetcher).not.toHaveBeenCalled();
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  expect(
    (await nativeConnectorDriver("api-key", "vault").verify(saved.connectionId))
      .status,
  ).toBe("connected");
  expect(fresh.fetcher).toHaveBeenCalledOnce();
});
