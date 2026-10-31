import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderModule } from "../../scripts/emit-connector-catalog.mjs";
import { CAPABILITIES } from "./capabilities.js";
import {
  CATALOG_ALIASES,
  CATALOG_ROW_JSON,
} from "./connector-catalog.generated.js";
import {
  CATALOG_REVISION,
  canonicalProviderId,
  catalogProvider,
  catalogProviders,
} from "./connector-catalog.js";
import { FIELDS } from "./embedded-catalog-data.js";
import { getBundledProviders } from "./embedded-catalog.js";
import { GIT_BACKUP_PROVIDER_IDS } from "./git-backup-forges.js";
import { SECRET_BACKEND_PRESETS } from "./secret-backends/presets.generated.js";
import { WALLET_ISSUER_IDS } from "./wallet-issuers.js";

const here = dirname(fileURLToPath(import.meta.url));
const view = JSON.parse(
  readFileSync(
    join(here, "../../../../spec/connectors/catalog.view.json"),
    "utf8",
  ),
);

function unknown(ids: Iterable<string>): string[] {
  return [...ids].filter((id) => canonicalProviderId(id) === undefined);
}

describe("the one integration catalog", () => {
  it("embeds exactly the Host API's view of spec/connectors/catalog.json", () => {
    // Compared as data: the checked-in module is Biome-formatted.
    const rendered = renderModule();
    expect(CATALOG_REVISION).toBe(view.revision);
    expect(CATALOG_ROW_JSON.map((row) => JSON.parse(row))).toEqual(
      view.providers.map(
        ({ aliases: _aliases, ...row }: { aliases: string[] }) => row,
      ),
    );
    for (const [alias, id] of Object.entries(CATALOG_ALIASES)) {
      expect(rendered).toContain(
        `${JSON.stringify(alias)}: ${JSON.stringify(id)}`,
      );
    }
    expect(Object.keys(CATALOG_ALIASES)).toHaveLength(
      view.providers.flatMap((row: { aliases: string[] }) => row.aliases)
        .length,
    );
  });

  it("resolves an alias to the row it names", () => {
    expect(canonicalProviderId("aws-secrets-manager")).toBe("aws");
    expect(catalogProvider("aws-secrets-manager")?.displayName).toBe(
      catalogProvider("aws")?.displayName,
    );
    expect(canonicalProviderId("not-an-integration")).toBeUndefined();
    expect(catalogProviders().length).toBe(view.providers.length);
  });

  it("every provider this app lists is a catalog row", () => {
    expect(unknown(getBundledProviders().map((p) => p.id))).toEqual([]);
    expect(unknown(CAPABILITIES.flatMap((c) => c.connectorIds))).toEqual([]);
    expect(unknown(WALLET_ISSUER_IDS)).toEqual([]);
    expect(unknown(GIT_BACKUP_PROVIDER_IDS)).toEqual([]);
  });

  it("bundles every shared secret backend preset through its canonical catalog row", () => {
    const bundledIds = new Set(
      getBundledProviders().map((provider) => canonicalProviderId(provider.id)),
    );
    for (const preset of SECRET_BACKEND_PRESETS) {
      const row = catalogProvider(preset.providerId);
      expect(row, preset.providerId).toBeDefined();
      expect(row?.displayName, preset.providerId).toBe(preset.label);
      expect(["password_managers", "cloud_secret_storage"]).toContain(
        row?.category,
      );
      expect(bundledIds.has(preset.providerId), preset.providerId).toBe(true);
    }
    expect(catalogProviders()).toHaveLength(191);
  });

  it("keeps native Host credential fields separate from browser secret backend configuration", () => {
    const hostFields = {
      "1password": ["service_account_token", "account", "vault"],
      bitwarden: [
        "session_token",
        "server_url",
        "organization_id",
        "collection_id",
      ],
      vaultwarden: [
        "session_token",
        "server_url",
        "organization_id",
        "collection_id",
      ],
      "proton-pass": ["agent_token", "vault"],
      passwordstate: ["base_url", "api_key", "password_list_id"],
      infisical: ["token", "host", "project_id", "environment"],
      "bitwarden-sm": [
        "access_token",
        "organization_id",
        "project_id",
        "server_url",
      ],
    };
    for (const [id, fields] of Object.entries(hostFields)) {
      const row = catalogProvider(id);
      expect(
        row?.configurationFields?.map((entry) => entry.name),
        id,
      ).toEqual(fields);
      expect(row?.operations, id).toEqual(["secret.configure"]);
    }
    for (const id of [
      "byo-secret-backend",
      "local-vault",
      "browser-credentials",
    ]) {
      const row = catalogProvider(id);
      expect(row?.category).toBe("password_managers");
      expect(row?.egress).toEqual({
        scheme: "none",
        authorities: [],
        pathPrefixes: [],
      });
      expect(row?.operations).toEqual(["secret.configure"]);
    }
  });

  it("offers BYO AI without granting a static host or a delegated model protocol", () => {
    const row = catalogProvider("byo-ai");
    expect(row?.category).toBe("ai_model_provider");
    expect(row?.authKind).toBe("configuration");
    expect(row?.modelApi).toEqual({ protocol: "rest_json" });
    expect(row?.egress).toEqual({
      scheme: "none",
      authorities: [],
      pathPrefixes: [],
    });
    expect(
      row?.configurationFields?.map(({ name, secret, required }) => [
        name,
        secret,
        required,
      ]),
    ).toEqual([
      ["family", false, true],
      ["base_url", false, true],
      ["model", false, true],
      ["authentication", false, true],
      ["api_key", true, false],
    ]);
    expect(getBundledProviders().some(({ id }) => id === "byo-ai")).toBe(true);
  });

  it("takes each listed row's data from the catalog", () => {
    for (const provider of getBundledProviders()) {
      const row = catalogProvider(provider.id);
      expect(provider.displayName, provider.id).toBe(row?.displayName);
      expect(provider.category, provider.id).toBe(row?.category);
      expect(provider.operations, provider.id).toEqual(row?.operations);
      expect(provider.egress, provider.id).toEqual(row?.egress);
    }
  });

  it("keeps its own field sets only where it already did", () => {
    // A known divergence from the one definition: this list may only shrink.
    expect([...FIELDS.keys()].sort()).toEqual(
      [
        "age",
        "apple-wallet",
        "aws-kms",
        "bitwarden",
        "bitwarden-secrets-manager",
        "gcp-kms",
        "google-wallet",
        "keepass",
        "keychain",
        "password-store",
        "plain",
        "samsung-wallet",
        "tailscale",
      ].sort(),
    );
  });
});
