import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { expect, it, vi } from "vitest";
import { nativeCatalogConfigurationDescriptor } from "./native-catalog-configuration-descriptor.js";
import { nativeDeviceProviderDescriptor } from "./native-device-provider-descriptor.js";

it("formats configuration-only catalog fields separately from provider verification", () => {
  const provider = catalogProvider("google-wallet");
  if (!provider) throw new Error("Missing Google Wallet catalog row");
  const descriptor = nativeCatalogConfigurationDescriptor(provider, true);
  expect(descriptor?.methods).toHaveLength(1);
  const method = descriptor?.methods[0];
  expect(method).toMatchObject({
    id: "native-local",
    available: true,
  });
  expect(method?.authorizeFirst).toBeUndefined();
  expect(
    method?.fields.map((field) => [field.id, field.secret, field.required]),
  ).toEqual([
    ["issuer_id", false, true],
    ["class_id", false, true],
    ["service_account_email", false, true],
    ["service_account_key", true, true],
  ]);
  expect(method?.instructions).toContain("makes no provider request");
  expect(method?.instructions).toContain("does not verify provider access");
  expect(descriptor?.disconnectExplanation).toContain("no provider request");
});

it("leaves Google Wallet to its specialized key driver instead of generic local configuration", () => {
  const has = vi.fn(() => false);
  expect(nativeDeviceProviderDescriptor("google-wallet", { has })).toBeNull();
  expect(has).not.toHaveBeenCalled();
});

it("does not turn providers without a configuration-only no-egress contract into local connectors", () => {
  for (const id of ["google", "github", "unknown-provider"]) {
    const provider = catalogProvider(id);
    if (provider)
      expect(nativeCatalogConfigurationDescriptor(provider, true)).toBeNull();
    expect(
      nativeDeviceProviderDescriptor(id, { has: () => false })?.methods[0]?.id,
    ).not.toBe("native-local");
  }
});
