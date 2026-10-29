/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { kvForgetAll } from "@opensesame/app-core/lib/kv.js";
import { resetNativeConnectorDrivers } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { mergeVercelCatalog } from "@opensesame/app-core/lib/vercel-connect-catalog.js";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import {
  closeGenuineRuntimeFixture,
  genuineRuntimeFixture,
} from "../../../modules/connectors.external/genuine-runtime.test-support.js";
import { NativeConnectorForm } from "./NativeConnectorForm.js";
import { nativeSettingsDescriptor } from "./NativeConnectorPanels.js";
import { nativeUiController } from "./native-connector-ui.test-support.js";

const routes = [
  ["vault", "api-key"],
  ["vault", "oidc"],
  ["openbao", "api-key"],
  ["openbao", "oidc"],
  ["make", "mcp"],
  ["asana", "oauth"],
] as const;

function descriptorFor(id: string) {
  const provider =
    catalogProvider(id) ??
    mergeVercelCatalog(getBundledProviders()).find((row) => row.id === id);
  if (!provider) throw new Error(`Missing catalog provider ${id}`);
  const descriptor = nativeSettingsDescriptor(provider);
  if (!descriptor) throw new Error(`Missing ${id} descriptor`);
  return descriptor;
}

function methodFor(id: string, method: string) {
  const result = descriptorFor(id).methods.find((entry) => entry.id === method);
  if (!result) throw new Error(`Missing ${id} ${method} method`);
  return result;
}

it("requires a genuine session for credentials before drivers register and after lock", async () => {
  const controller = nativeUiController();
  const fetcher = vi.spyOn(globalThis, "fetch");
  try {
    await closeGenuineRuntimeFixture();
    kvForgetAll();
    resetNativeConnectorDrivers();
    await vaultStore.createGuest();
    expect(vaultStore.isGenuineSession()).toBe(false);
    for (const [id, method] of routes) {
      const entry = methodFor(id, method);
      expect(entry.available, `${id} ${method}`).toBe(false);
      expect(entry.configurable, `${id} ${method}`).not.toBe(true);
    }
    for (const id of ["vault", "openbao", "make", "asana"]) {
      const rendered = render(
        <MemoryRouter>
          <NativeConnectorForm
            descriptor={descriptorFor(id)}
            controller={controller}
            onChanged={vi.fn()}
            onFlash={vi.fn()}
          />
        </MemoryRouter>,
      );
      expect(
        rendered.container.querySelector("input, select, textarea"),
        id,
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: /sign in|connect/i }),
        id,
      ).toBeNull();
      rendered.unmount();
    }
    expect(controller.configure).not.toHaveBeenCalled();
    expect(controller.connect).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();

    await genuineRuntimeFixture();
    expect(vaultStore.isGenuineSession()).toBe(true);
    for (const [id, method] of routes)
      expect(methodFor(id, method).available, `${id} ${method}`).toBe(true);

    vaultStore.lock();
    expect(vaultStore.isGenuineSession()).toBe(false);
    for (const [id, method] of routes)
      expect(methodFor(id, method).available, `${id} ${method}`).toBe(false);
  } finally {
    fetcher.mockRestore();
    cleanup();
    await closeGenuineRuntimeFixture();
    kvForgetAll();
    resetNativeConnectorDrivers();
  }
});
