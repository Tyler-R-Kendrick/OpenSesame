import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import * as nativeDrivers from "@opensesame/app-core/lib/native-connector-drivers.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { expect, it, vi } from "vitest";
import { nativeSettingsDescriptor } from "./NativeConnectorPanels.js";

it("withholds a compiled token form without a genuine vault session", () => {
  const provider = catalogProvider("github");
  if (!provider) throw new Error("GitHub catalog row required");
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

it("exposes compiled local runtime configuration only with a genuine vault and active capability", () => {
  const genuine = vi
    .spyOn(vaultStore, "isGenuineSession")
    .mockReturnValue(true);
  const withdrawn = vi
    .spyOn(nativeDrivers, "nativeConnectorWithdrawn")
    .mockReturnValue(false);
  const driver = vi
    .spyOn(nativeDrivers, "hasNativeConnectorDriver")
    .mockReturnValue(true);
  try {
    for (const id of ["vercel-sandbox", "e2b", "browserbase-cdp"]) {
      const provider = catalogProvider(id);
      if (!provider) throw new Error(`Missing ${id} catalog row`);
      expect(nativeSettingsDescriptor(provider)?.methods[0]).toMatchObject({
        id: "native-local",
        available: true,
      });
      genuine.mockReturnValue(false);
      expect(nativeSettingsDescriptor(provider)?.methods[0]?.available).toBe(
        false,
      );
      genuine.mockReturnValue(true);
      withdrawn.mockReturnValue(true);
      expect(nativeSettingsDescriptor(provider)?.methods[0]?.available).toBe(
        false,
      );
      withdrawn.mockReturnValue(false);
    }
  } finally {
    genuine.mockRestore();
    withdrawn.mockRestore();
    driver.mockRestore();
  }
});
