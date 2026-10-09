import { hasConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { isConnectionCatalogProvider } from "@opensesame/app-core/lib/connector-guidance.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { expect, it, vi } from "vitest";
import {
  type NativeDeviceAvailability,
  nativeDeviceProviderDescriptor,
} from "./native-device-provider-descriptor.js";

it("covers every visible bundled provider without a plan or replacing a specialized road", () => {
  const visible = getBundledProviders()
    .filter(isConnectionCatalogProvider)
    .filter((provider) => !hasConnectPlan(provider.id));
  expect(visible).toHaveLength(31);
  const has = vi.fn<NativeDeviceAvailability["has"]>(() => false);
  for (const provider of visible) {
    const descriptor = nativeDeviceProviderDescriptor(provider.id, { has });
    if (["git", "aws-kms", "gcp-kms", "s3"].includes(provider.id)) {
      expect(descriptor).toBeNull();
      continue;
    }
    expect(descriptor?.providerId).toBe(provider.id);
    expect(descriptor?.docsUrl).toBe(catalogProvider(provider.id)?.docsUrl);
    expect(descriptor?.methods).toHaveLength(1);
    const method = descriptor?.methods[0];
    expect(method?.available).toBe(false);
    expect(method?.fields).toEqual([]);
    expect(method?.unavailableReason).toContain(descriptor?.name);
    expect(descriptor?.actions).toEqual([]);
  }
  expect(has.mock.calls.map((call) => call)).toEqual([
    ["api-key", "vault"],
    ["api-key", "openbao"],
  ]);
});

it.each(["vault", "openbao"])(
  "offers %s only through its actually registered API-key driver",
  (id) => {
    const has = vi.fn<NativeDeviceAvailability["has"]>(
      (method, provider) => method === "api-key" && provider === id,
    );
    const descriptor = nativeDeviceProviderDescriptor(id, { has });
    const method = descriptor?.methods[0];
    expect(has).toHaveBeenCalledWith("api-key", id);
    expect(method?.available).toBe(true);
    expect(
      method?.fields.map((field) => [field.id, field.secret, field.required]),
    ).toEqual([
      ["endpoint", false, true],
      ["namespace", false, false],
      ["api_key", true, true],
    ]);
    expect(method?.scopeGroups).toEqual([]);
    expect(method?.instructions).toContain("CORS");
    expect(method?.instructions).toContain("lookup-self");
    expect(method?.instructions).toContain("does not revoke");
    expect(method?.links?.[0]?.url).toMatch(/^https:\/\//);
  },
);

it("leaves companion configuration and imports distinct from provider access", () => {
  const companions = getBundledProviders()
    .filter(isConnectionCatalogProvider)
    .map((provider) =>
      nativeDeviceProviderDescriptor(provider.id, { has: () => false }),
    )
    .filter((descriptor) => descriptor?.configurationLinks?.length);
  expect(companions).toHaveLength(9);
  for (const descriptor of companions) {
    expect(descriptor?.configurationLinks?.[0]?.to).toBe("/vault?f=all");
    expect(descriptor?.methods[0]?.available).toBe(false);
    expect(descriptor?.methods[0]?.unavailableReason).toContain(
      "local snapshot",
    );
    expect(descriptor?.methods[0]?.unavailableReason).toContain(
      "browser cannot run",
    );
  }
});

it("does not infer an unimplemented cloud or wallet driver from registry availability", () => {
  const has = vi.fn(() => true);
  const cloud = nativeDeviceProviderDescriptor("aws-secrets-manager", { has });
  expect(cloud?.methods[0]?.available).toBe(false);
  expect(cloud?.methods[0]?.unavailableReason).toContain("region");
  const wallet = nativeDeviceProviderDescriptor("apple-wallet", { has });
  expect(wallet?.methods[0]?.available).toBe(false);
  expect(wallet?.methods[0]?.unavailableReason).toContain(
    "wallet connection policy",
  );
  expect(wallet?.methods[0]?.unavailableReason).toContain("pass type id");
  expect(has).not.toHaveBeenCalled();
});

it("returns no descriptor for unknown IDs, plans, or preserved specialized git roads", () => {
  for (const id of [
    "unlisted-provider",
    "linear",
    "gitlab",
    "git",
    "aws-kms",
    "gcp-kms",
    "s3",
  ])
    expect(nativeDeviceProviderDescriptor(id, { has: () => true })).toBeNull();
});
