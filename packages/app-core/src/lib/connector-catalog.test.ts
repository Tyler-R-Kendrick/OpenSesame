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
        "auth0",
        "aws-kms",
        "azure-key-vault-keys",
        "better-auth",
        "bitwarden",
        "bitwarden-secrets-manager",
        "cloudflare-wallet",
        "gcp-kms",
        "google-wallet",
        "keepass",
        "keychain",
        "password-store",
        "plain",
        "samsung-wallet",
        "tailscale",
        "yubikey",
      ].sort(),
    );
  });
});
