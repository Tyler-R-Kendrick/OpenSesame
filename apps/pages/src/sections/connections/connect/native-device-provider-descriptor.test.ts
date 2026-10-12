import { hasConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { isConnectionCatalogProvider } from "@opensesame/app-core/lib/connector-guidance.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { isNativeAwsProvider } from "@opensesame/app-core/lib/native-aws-input.js";
import { expect, it, vi } from "vitest";
import {
  type NativeDeviceAvailability,
  nativeDeviceProviderDescriptor,
} from "./native-device-provider-descriptor.js";

/**
 * Every provider says why, in a closed reason, and never in the old catch-all.
 * (An instance's own roads are unavailable only until their driver registers.)
 */
function expectHonestReason(
  method: { unavailableKind?: string; unavailableReason?: string } | undefined,
  id: string,
  instance: boolean,
) {
  if (!instance) {
    expect(method?.unavailableKind, id).toBeDefined();
    expect(method?.unavailableReason?.length, id).toBeGreaterThan(40);
  }
  expect(method?.unavailableReason).not.toContain(
    "no supported browser driver",
  );
  expect(method?.unavailableReason).not.toContain("cannot run that companion");
}

it("covers every visible bundled provider without a plan or replacing a specialized road", () => {
  const visible = getBundledProviders()
    .filter(isConnectionCatalogProvider)
    .filter((provider) => !hasConnectPlan(provider.id));
  // The 31 that were here, and the 48 model providers a browser cannot reach yet (ADR 0192).
  expect(visible).toHaveLength(79);
  const has = vi.fn<NativeDeviceAvailability["has"]>(() => false);
  for (const provider of visible) {
    const descriptor = nativeDeviceProviderDescriptor(provider.id, { has });
    if (
      ["git", "aws-kms", "gcp-kms", "s3"].includes(provider.id) ||
      isNativeAwsProvider(provider.id)
    ) {
      expect(descriptor).toBeNull();
      continue;
    }
    expect(descriptor?.providerId).toBe(provider.id);
    expect(descriptor?.docsUrl).toBe(catalogProvider(provider.id)?.docsUrl);
    const instance = ["vault", "openbao"].includes(provider.id);
    expect(descriptor?.methods).toHaveLength(instance ? 2 : 1);
    const method = descriptor?.methods.find(
      (method) => method.id === "api-key" || method.id === "native-local",
    );
    expect(method?.available).toBe(false);
    expect(method?.fields).toEqual([]);
    expectHonestReason(method, provider.id, instance);
    expect(descriptor?.actions).toEqual([]);
  }
  expect(has.mock.calls.map((call) => call)).toEqual([
    ["api-key", "vault"],
    ["oidc", "vault"],
    ["api-key", "openbao"],
    ["oidc", "openbao"],
  ]);
});

it.each(["vault", "openbao"])(
  "offers %s only through its actually registered API-key driver",
  (id) => {
    const has = vi.fn<NativeDeviceAvailability["has"]>(
      (method, provider) => method === "api-key" && provider === id,
    );
    const descriptor = nativeDeviceProviderDescriptor(id, { has });
    const method = descriptor?.methods.find(
      (method) => method.id === "api-key",
    );
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

it("offers the vault import only where an import exists, and says it is a snapshot", () => {
  const withImport = getBundledProviders()
    .filter(isConnectionCatalogProvider)
    .map((provider) => ({
      id: provider.id,
      descriptor: nativeDeviceProviderDescriptor(provider.id, {
        has: () => false,
      }),
    }))
    .filter(({ descriptor }) =>
      descriptor?.configurationLinks?.some(
        (link) => link.to === "/vault?f=all",
      ),
    );
  expect(withImport.map(({ id }) => id).sort()).toEqual([
    "1password",
    "bitwarden",
    "keepass",
    "proton-pass",
    "vaultwarden",
  ]);
  for (const { descriptor } of withImport) {
    expect(descriptor?.methods[0]?.available).toBe(false);
    expect(descriptor?.methods[0]?.unavailableReason).toContain(
      "local snapshot",
    );
  }
});

it("says Bitwarden's real constraint, with Bitwarden's own pages, not fnox's", () => {
  const descriptor = nativeDeviceProviderDescriptor("bitwarden", {
    has: () => false,
  });
  const method = descriptor?.methods[0];
  expect(method?.unavailableKind).toBe("companion");
  expect(method?.label).toBe("Companion configuration");
  expect(method?.unavailableReason).toContain("bw serve");
  expect(method?.unavailableReason).toContain("Origin header");
  expect(method?.unavailableReason).not.toContain(
    "no supported browser driver",
  );
  expect(descriptor?.docsUrl).toBe(
    "https://bitwarden.com/help/bitwarden-apis/",
  );
  // The APIs page is already the documentation link: it is not listed twice.
  expect(descriptor?.externalLinks?.map((link) => link.url)).toEqual([
    "https://bitwarden.com/help/cli/",
  ]);
  for (const url of [
    descriptor?.docsUrl,
    ...(descriptor?.externalLinks ?? []).map((link) => link.url),
  ])
    expect(new URL(url ?? "").hostname).toBe("bitwarden.com");
});

it("does not call a provider whose API a browser can reach a companion", () => {
  const has = vi.fn(() => true);
  for (const id of ["aws-sts", "azure-ac", "gcp", "gcp-iam"]) {
    const method = nativeDeviceProviderDescriptor(id, { has })?.methods[0];
    expect(method?.available).toBe(false);
    expect(method?.unavailableKind, id).toBe("driver-pending");
    expect(method?.label, id).not.toBe("Companion configuration");
    expect(method?.unavailableReason, id).toContain("answers browser");
  }
  expect(has).not.toHaveBeenCalled();
});

it("does not infer an unimplemented cloud or wallet driver from registry availability", () => {
  const has = vi.fn(() => true);
  const cloud = nativeDeviceProviderDescriptor("aws-sts", { has });
  expect(cloud?.methods[0]?.available).toBe(false);
  expect(cloud?.methods[0]?.unavailableKind).toBe("driver-pending");
  const wallet = nativeDeviceProviderDescriptor("apple-wallet", { has });
  expect(wallet?.methods[0]?.available).toBe(false);
  expect(wallet?.methods[0]?.unavailableKind).toBe("policy");
  expect(wallet?.methods[0]?.unavailableReason).toContain(
    "wallet connection policy",
  );
  expect(has).not.toHaveBeenCalled();
});

it("tells a built-in function where it lives instead of calling it unavailable", () => {
  const descriptor = nativeDeviceProviderDescriptor("webcrypto", {
    has: () => false,
  });
  expect(descriptor?.methods[0]?.unavailableKind).toBe("built-in");
  expect(descriptor?.methods[0]?.label).toBe("Built in");
  expect(descriptor?.configurationLinks).toEqual([
    { label: "Open Settings › Security", to: "/settings/security" },
  ]);
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

it("keeps no disposition for a provider that has a road, so a shipped driver retires its row", async () => {
  const { authoredDispositionIds } = await import(
    "@opensesame/app-core/lib/browser-disposition.js"
  );
  for (const id of authoredDispositionIds())
    expect(
      nativeDeviceProviderDescriptor(id, { has: () => false }),
      `${id} has a road elsewhere; remove its row from browser-dispositions.json`,
    ).not.toBeNull();
});

it("sends the AWS secret stores to their own road, not to a disposition", () => {
  // The app routes by the alias a person arrived through as well.
  for (const id of [
    "aws",
    "aws-ps",
    "aws-secrets-manager",
    "aws-parameter-store",
  ])
    expect(nativeDeviceProviderDescriptor(id, { has: () => true })).toBeNull();
});
