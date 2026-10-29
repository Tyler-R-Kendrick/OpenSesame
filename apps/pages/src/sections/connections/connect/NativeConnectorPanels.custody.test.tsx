import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
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
