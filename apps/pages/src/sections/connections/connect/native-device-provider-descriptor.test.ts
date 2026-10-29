import { isAiConnectionProvider } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { hasConnectPlan } from "@opensesame/app-core/lib/connect-plan.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { isConnectionCatalogProvider } from "@opensesame/app-core/lib/connector-guidance.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { identityConnectionPreset } from "@opensesame/app-core/lib/identity-connections-presets.js";
import { nativeCatalogConfiguration } from "@opensesame/app-core/lib/native-catalog-configuration.js";
import { nativeKeyDriverFor } from "@opensesame/app-core/lib/native-key-drivers.js";
import {
  isSecretBackendProvider,
  secretBackendPreset,
} from "@opensesame/app-core/lib/secret-backends/presets.js";
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

function hasSpecializedConfiguration(providerId: string): boolean {
  return (
    ["git", "aws-kms", "gcp-kms", "s3", "tailscale"].includes(providerId) ||
    isAiConnectionProvider(providerId) ||
    nativeKeyDriverFor(providerId) !== null ||
    identityConnectionPreset(providerId) !== null ||
    isSecretBackendProvider(providerId)
  );
}

it("covers every visible bundled provider without a plan or replacing a specialized road", () => {
  const visible = getBundledProviders()
    .filter(isConnectionCatalogProvider)
    .filter((provider) => !hasConnectPlan(provider.id));
  // Local and device integrations, the model providers that need a cloud signer, a tenant
  // address or a probe nobody has run (ADR 0192, ADR 0198), and the ones bundled for their
  // drivers, which have a specialized road. Seventeen model providers left it when their key
  // check was found (ADR 0199).
  expect(
    visible
      .filter((provider) => isSecretBackendProvider(provider.id))
      .map((provider) => provider.id)
      .sort(),
  ).toEqual([
    "1password",
    "bitwarden",
    "bitwarden-secrets-manager",
    "browser-credentials",
    "byo-secret-backend",
    "encrypted-remote",
    "infisical",
    "local-vault",
    "passwordstate",
    "proton-pass",
    "vaultwarden",
  ]);
  expect(
    visible
      .filter((provider) => identityConnectionPreset(provider.id))
      .map((provider) => provider.id),
  ).toEqual(["byo-identity", "better-auth", "neon-auth"]);
  const has = vi.fn<NativeDeviceAvailability["has"]>(() => false);
  for (const provider of visible) {
    const descriptor = nativeDeviceProviderDescriptor(provider.id, { has });
    if (hasSpecializedConfiguration(provider.id)) {
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
    if (nativeCatalogConfiguration(provider.id)) {
      expect(method).toMatchObject({
        id: "native-local",
        available: false,
        unavailableKind: "runtime-inactive",
      });
      expect(method?.fields).toEqual([]);
    } else {
      expect(method?.available).toBe(false);
      expect(method?.fields).toEqual([]);
      expectHonestReason(method, provider.id, instance);
    }
    expect(descriptor?.actions).toEqual([]);
  }
  expect(has.mock.calls).toEqual(
    visible
      .filter((provider) => nativeKeyDriverFor(provider.id) === null)
      .flatMap((provider) =>
        ["vault", "openbao"].includes(provider.id)
          ? [
              ["api-key", provider.id],
              ["oidc", provider.id],
            ]
          : nativeCatalogConfiguration(provider.id)
            ? [["native-local", provider.id]]
            : [],
      ),
  );
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
  expect(withImport.map(({ id }) => id).sort()).toEqual(["keepass"]);
  for (const { descriptor } of withImport) {
    expect(descriptor?.methods[0]?.available).toBe(false);
    expect(descriptor?.methods[0]?.unavailableReason).toContain(
      "local snapshot",
    );
  }
});

it.each([
  ["byo-secret-backend", "local"],
  ["local-vault", "local"],
  ["browser-credentials", "credential-management"],
  ["1password", "onepassword-connect"],
  ["bitwarden", "bitwarden-api"],
  ["vaultwarden", "bitwarden-api"],
  ["bitwarden-sm", "bitwarden-secrets"],
  ["bitwarden-secrets-manager", "bitwarden-secrets"],
  ["infisical", "infisical"],
  ["passwordstate", "passwordstate"],
  ["proton-pass", "file-import"],
])(
  "routes %s to its shared secret-backend configuration instead of a refusal",
  (id, mode) => {
    expect(secretBackendPreset(id)?.modes).toContain(mode);
    const has = vi.fn(() => false);
    expect(nativeDeviceProviderDescriptor(id, { has })).toBeNull();
    expect(has).not.toHaveBeenCalled();
  },
);

it("does not call a provider whose API a browser can reach a companion", async () => {
  const { authoredDispositionIds, browserDisposition } = await import(
    "@opensesame/app-core/lib/browser-disposition.js"
  );
  const has = vi.fn(() => true);
  // Whatever is still waiting for its driver; the list falls as each one ships.
  for (const id of authoredDispositionIds()) {
    const provider = catalogProvider(id);
    if (!provider || browserDisposition(provider).kind !== "driver-pending")
      continue;
    const method = nativeDeviceProviderDescriptor(id, { has })?.methods[0];
    expect(method?.available, id).toBe(false);
    expect(method?.unavailableKind, id).toBe("driver-pending");
    expect(method?.label, id).not.toBe("Companion configuration");
    expect(method?.unavailableReason, id).toContain("answers browser");
  }
  expect(has).not.toHaveBeenCalled();
});

it("records no provider as waiting for a driver: where a browser can reach the API, the driver ships", async () => {
  const { authoredDispositionIds, browserDisposition } = await import(
    "@opensesame/app-core/lib/browser-disposition.js"
  );
  const waiting = authoredDispositionIds().filter((id) => {
    const provider = catalogProvider(id);
    return provider && browserDisposition(provider).kind === "driver-pending";
  });
  expect(
    waiting,
    "build the driver instead of recording that it is missing",
  ).toEqual([]);
});

it("keeps Google Wallet on its specialized verified-key path", () => {
  const has = vi.fn(() => true);
  expect(nativeKeyDriverFor("google-wallet")).not.toBeNull();
  expect(nativeDeviceProviderDescriptor("google-wallet", { has })).toBeNull();
  expect(has).not.toHaveBeenCalled();
});

it("keeps Apple Wallet under the existing wallet policy", () => {
  const has = vi.fn(() => false);
  const wallet = nativeDeviceProviderDescriptor("apple-wallet", { has });
  expect(wallet?.methods[0]).toMatchObject({
    id: "native-local",
    available: false,
    unavailableKind: "policy",
  });
  expect(wallet?.methods[0]?.unavailableReason).toContain(
    "provisioning is unavailable",
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
    "aws-sts",
    "azure-ac",
    "gcp",
    "gcp-iam",
    "letsencrypt",
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
