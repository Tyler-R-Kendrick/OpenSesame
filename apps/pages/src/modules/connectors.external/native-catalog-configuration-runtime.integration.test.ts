import { generateKeyPairSync } from "node:crypto";
import { deviceProviderRevokers } from "@opensesame/app-core/lib/device-connectors.js";
import { modelMemoryBackend } from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeConnectorController } from "../../sections/connections/connect/native-connector-controller.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import {
  closeGenuineRuntimeFixture,
  genuineRuntimeFixture,
} from "./genuine-runtime.test-support.js";
import { bindNativeCatalogConfigurationRuntime } from "./native-catalog-configuration-runtime.js";
import { bindNativeCleanupRuntime } from "./native-cleanup-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";

const secret = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const disposers: (() => void)[] = [];

function activate() {
  const test = createTestContext();
  const fetcher = vi.fn<typeof test.ctx.egress.fetch>();
  const ctx = { ...test.ctx, egress: { ...test.ctx.egress, fetch: fetcher } };
  const activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  bindNativeCatalogConfigurationRuntime(activation);
  bindNativeCleanupRuntime(activation);
  disposers.push(activation.dispose);
  return fetcher;
}

beforeEach(async () => {
  await genuineRuntimeFixture();
  modelMemoryBackend();
});

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  await closeGenuineRuntimeFixture();
  vi.restoreAllMocks();
});

it("configures, verifies, reviews and removes Google Wallet with zero provider calls", async () => {
  const fetcher = activate();
  const controller = nativeConnectorController({
    id: "google-wallet",
    refused: false,
  });
  const saved = await controller.connect({
    method: "native-local",
    displayName: "Synthetic Google Wallet",
    icon: "",
    parameters: {
      issuer_id: "1234567890",
      class_id: "1234567890.synthetic.class",
      service_account_email: "synthetic@example.invalid",
    },
    credentials: { service_account_key: secret },
    requestedScopes: {},
    targetIds: {},
  });
  expect(saved.status).toBe("connected");
  expect(saved.configuration.method).toBe("native-local");
  expect(JSON.stringify(saved)).not.toContain(secret);

  const verified = await controller.verify();
  expect(verified.status).toBe("connected");
  const reviewed = await controller.invoke("provider.read", {});
  expect(reviewed.label).toBe("Google Wallet local configuration");
  expect(reviewed.items).toContainEqual({
    id: "status",
    label: "Configuration verified locally; provider access was not checked",
  });
  expect(JSON.stringify(reviewed)).not.toContain(secret);

  const revoke = deviceProviderRevokers["google-wallet"];
  if (!revoke) throw new Error("Missing production Google Wallet revoker");
  await revoke(saved.connectionId);
  expect(readNativeConnector(saved.connectionId)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it("refuses to publish a local configuration for a retired form owner", async () => {
  const fetcher = activate();
  const retired = new AbortController();
  retired.abort();
  await expect(
    nativeConnectorDriver("native-local", "google-wallet").configure({
      owner: {
        signal: retired.signal,
        assertCurrent: () => retired.signal.throwIfAborted(),
      },
      providerId: "google-wallet",
      method: "native-local",
      displayName: "Retired Google Wallet",
      parameters: {
        issuer_id: "1234567890",
        class_id: "1234567890.synthetic.class",
        service_account_email: "synthetic@example.invalid",
      },
      credentials: { service_account_key: secret },
      requestedScopes: {},
      targetIds: {},
    }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
