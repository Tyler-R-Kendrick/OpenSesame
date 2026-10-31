/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { modelMemoryBackend } from "@opensesame/app-core/lib/hosted-model.test-support.js";
import { hasNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createActivation } from "../../../modules/activation.js";
import {
  closeGenuineRuntimeFixture,
  genuineRuntimeFixture,
} from "../../../modules/connectors.external/genuine-runtime.test-support.js";
import { bindNativeCatalogConfigurationRuntime } from "../../../modules/connectors.external/native-catalog-configuration-runtime.js";
import { bindNativeRuntime } from "../../../modules/connectors.external/native-runtime.js";
import { createTestContext } from "../../../modules/test-context.js";
import { nativeSettingsDescriptor } from "./NativeConnectorPanels.js";

const disposers: (() => void)[] = [];

function activate() {
  const test = createTestContext();
  const fetcher = vi.fn<typeof test.ctx.egress.fetch>();
  const ctx = { ...test.ctx, egress: { ...test.ctx.egress, fetch: fetcher } };
  const activation = createActivation(ctx, "connectors.external");
  bindNativeRuntime(ctx, activation);
  bindNativeCatalogConfigurationRuntime(activation);
  disposers.push(activation.dispose);
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

it("offers local catalog configuration through the production descriptor", () => {
  activate();
  for (const id of ["vercel-sandbox", "e2b", "browserbase-cdp"]) {
    const provider = catalogProvider(id);
    if (!provider) throw new Error(`Actual ${id} catalog entry required`);
    expect(hasNativeConnectorDriver("native-local", id), id).toBe(true);
    const method = nativeSettingsDescriptor(provider)?.methods[0];
    expect(method, id).toMatchObject({
      id: "native-local",
      label: "Local configuration",
      available: true,
    });
  }
});

it("withholds local catalog configuration without a genuine vault session", () => {
  activate();
  const provider = catalogProvider("e2b");
  if (!provider) throw new Error("Actual e2b catalog entry required");
  const genuine = vi
    .spyOn(vaultStore, "isGenuineSession")
    .mockReturnValue(false);
  try {
    expect(nativeSettingsDescriptor(provider)?.methods[0]?.available).toBe(
      false,
    );
  } finally {
    genuine.mockRestore();
  }
});
