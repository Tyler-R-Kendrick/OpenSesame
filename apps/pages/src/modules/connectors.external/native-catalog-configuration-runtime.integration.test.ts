import { generateKeyPairSync } from "node:crypto";
import {
  readDeviceRows,
  withDeviceConfigurationLock,
} from "@opensesame/app-core/lib/device-connector-records.js";
import { deviceProviderRevokers } from "@opensesame/app-core/lib/device-connectors.js";
import { modelMemoryBackend } from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { kvSeams } from "@opensesame/app-core/lib/kv.js";
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

it("does not commit a form retired while its local configuration waits for the storage lock", async () => {
  // The shared model fixture stubs durable writes without a pre-commit hook.
  // Restore both real KV operations so this tests the actual publication fence.
  vi.mocked(kvSeams.kvGet).mockRestore();
  vi.mocked(kvSeams.kvSetDurable).mockRestore();
  const fetcher = activate();
  let unlock = () => {};
  let lockEntered = () => {};
  const entered = new Promise<void>((resolve) => {
    lockEntered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const held = withDeviceConfigurationLock(async () => {
    lockEntered();
    await gate;
  });
  await entered;
  const owner = new AbortController();
  let ownerChecks = 0;
  const input = {
    providerId: "e2b",
    method: "native-local" as const,
    displayName: "Local E2B",
    parameters: {},
    credentials: {},
    requestedScopes: {},
    targetIds: {},
    owner: {
      signal: owner.signal,
      assertCurrent: () => {
        ownerChecks += 1;
        owner.signal.throwIfAborted();
      },
    },
  };
  let settled = false;
  const pending = nativeConnectorDriver("native-local", "e2b")
    .configure(input)
    .then(
      () => {
        settled = true;
        return false;
      },
      () => {
        settled = true;
        return true;
      },
    );
  try {
    await vi.waitFor(() => expect(ownerChecks).toBeGreaterThanOrEqual(2));
    expect(settled).toBe(false);
    owner.abort();
  } finally {
    unlock();
  }
  await held;
  expect(await pending).toBe(true);
  expect(readDeviceRows()).toHaveLength(0);
  const active = new AbortController();
  const saved = await nativeConnectorDriver("native-local", "e2b").configure({
    ...input,
    owner: {
      signal: active.signal,
      assertCurrent: () => active.signal.throwIfAborted(),
    },
  });
  expect(saved.status).toBe("connected");
  expect(readDeviceRows()).toHaveLength(1);
  expect(fetcher).not.toHaveBeenCalled();
});
