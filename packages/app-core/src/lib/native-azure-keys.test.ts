import { expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import {
  installNativeApiTests,
  nativeAnswers,
} from "./native-api.test-support.js";
import { azureKeysKeyFlows } from "./native-azure-keys.js";

installNativeApiTests();

const input = {
  providerId: "azure-kms",
  displayName: "Azure Key Vault Keys",
  parameters: { vault_url: "https://my-vault.vault.azure.net" },
  credentials: { token: "owned-token" },
};

it("verifies a Key Vault token with a bounded key-list call before saving", async () => {
  const fixture = nativeAnswers({
    body: {
      value: [
        {
          kid: "https://my-vault.vault.azure.net/keys/alpha",
          attributes: { enabled: true },
        },
      ],
    },
  });
  const saved = await azureKeysKeyFlows.configure(input, fixture.transport);
  expect(saved).toMatchObject({
    providerId: "azure-kms",
    status: "connected",
  });
  const [url, init] = fixture.fetch.mock.calls[0] ?? [];
  expect(String(url)).toBe(
    "https://my-vault.vault.azure.net/keys?api-version=2025-07-01&maxresults=25",
  );
  expect(new Headers(init?.headers).get("authorization")).toBe(
    "Bearer owned-token",
  );
  expect(readDeviceRows()).toHaveLength(1);
});

it("lists only validated key names after a connection is saved", async () => {
  const first = nativeAnswers({ body: { value: [] } });
  const saved = await azureKeysKeyFlows.configure(input, first.transport);
  const listing = nativeAnswers({
    body: {
      value: [
        { kid: "https://my-vault.vault.azure.net/keys/alpha" },
        { kid: "https://my-vault.vault.azure.net/keys/beta" },
      ],
    },
  });
  const result = await azureKeysKeyFlows.invoke(
    saved.connectionId,
    "provider.keys.read",
    {},
    listing.transport,
  );
  expect(result.items.map((item) => item.id)).toEqual(["alpha", "beta"]);
  expect(JSON.stringify(result)).not.toContain("owned-token");
});

it("does not save a connection when the provider response is not a key list", async () => {
  const fixture = nativeAnswers({ body: { value: [{ kid: 42 }] } });
  await expect(
    azureKeysKeyFlows.configure(input, fixture.transport),
  ).rejects.toThrow();
  expect(readDeviceRows()).toEqual([]);
});
