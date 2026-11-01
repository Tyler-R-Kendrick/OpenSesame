import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  renderBrowserDispositions,
  runtimeDispositions,
} from "../../scripts/emit-browser-dispositions.mjs";
import {
  AUTHORED_KINDS,
  UNAVAILABLE_LABEL,
  UNAVAILABLE_PRIORITY,
  auditedOrigin,
  authoredDisposition,
  authoredDispositionIds,
  browserDisposition,
  browserDispositionSpec,
  leadingUnavailableKind,
} from "./browser-disposition.js";
import { BROWSER_DISPOSITIONS_JSON } from "./browser-dispositions.generated.js";
import { hasConnectPlan } from "./connect-plan.js";
import {
  catalogProvenanceUrl,
  catalogProvider,
  catalogProviders,
} from "./connector-catalog.js";
import { isFnoxLink } from "./doc-link.js";
import {
  isSecretBackendProvider,
  secretBackendPreset,
} from "./secret-backends/presets.js";

const spec = () => browserDispositionSpec();

/** The two sentences this product used to say about every provider it had no road to. */
const CATCH_ALL = [
  "this browser cannot run that companion",
  "has no supported browser driver",
  "Desktop app required",
];

describe("the authored spec", () => {
  it("is what the generated module embeds", () => {
    const source = JSON.parse(
      readFileSync(
        new URL(
          "../../../../spec/connectors/browser-dispositions.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    // A browser reads the reasons, not the evidence behind them.
    expect(BROWSER_DISPOSITIONS_JSON).toBe(
      JSON.stringify(runtimeDispositions(source)),
    );
    expect(BROWSER_DISPOSITIONS_JSON).not.toContain("allow_origin");
    expect(renderBrowserDispositions(source)).toContain(
      "BROWSER_DISPOSITIONS_JSON",
    );
  });

  it("has one row per provider, each a provider the catalog lists", () => {
    const ids = authoredDispositionIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(catalogProvider(id), id).toBeDefined();
  });

  it("describes only providers that have no compiled browser contract", () => {
    for (const id of authoredDispositionIds()) {
      expect(
        hasConnectPlan(id),
        `${id} has a plan; browser-policy.json owns it`,
      ).toBe(false);
      expect(
        isSecretBackendProvider(id),
        `${id} has a secret-backend form`,
      ).toBe(false);
    }
  });

  it("labels every kind a row may use", () => {
    for (const kind of AUTHORED_KINDS)
      expect(UNAVAILABLE_LABEL[kind]).toBeTruthy();
  });

  it("names the audited origin and keeps every source https", () => {
    expect(auditedOrigin()).toBe("https://opensesame-labs.github.io");
    for (const row of spec().dispositions)
      for (const link of row.sources)
        expect(link.url, `${row.provider_id} source`).toMatch(/^https:\/\//);
  });
});

describe("every provider without a road gets an honest statement", () => {
  const roadless = catalogProviders().filter(
    (provider) =>
      !hasConnectPlan(provider.id) && !isSecretBackendProvider(provider.id),
  );

  it("is never the catch-all", () => {
    expect(roadless.length).toBeGreaterThan(50);
    for (const provider of roadless) {
      const { summary } = browserDisposition(provider);
      for (const phrase of CATCH_ALL)
        expect(summary, provider.id).not.toContain(phrase);
      expect(summary.length, provider.id).toBeGreaterThan(40);
    }
  });

  it("derives, from the catalog's own facts, what OpenSesame lacks", () => {
    const azure = catalogProvider("azure-sm");
    expect(azure && browserDisposition(azure)).toMatchObject({
      kind: "no-contract",
      authored: false,
    });
    expect(azure && browserDisposition(azure).summary).toContain(
      "configuration for fnox's azure-sm provider and names no HTTPS API",
    );
    expect(isFnoxLink(catalogProvenanceUrl("azure-sm") ?? "")).toBe(true);
  });

  it("says only that the catalog names no API where the row did not come from fnox", () => {
    const passbolt = catalogProvider("passbolt");
    expect(passbolt && browserDisposition(passbolt).summary).toBe(
      "OpenSesame has no browser connection for Passbolt. Its catalog entry names no HTTPS API a browser could call.",
    );
  });

  it("does not claim a fnox origin for a row that did not come from fnox", () => {
    const row = catalogProvider("mock");
    expect(row && browserDisposition(row).summary).not.toContain("fnox");
  });

  it("says a model provider with no fixed address has none to call", () => {
    const row = catalogProvider("litellm");
    expect(row && browserDisposition(row).summary).toContain(
      "no address to call",
    );
  });

  it("keeps the wallet policy for wallets", () => {
    const wallet = catalogProvider("apple-wallet");
    expect(wallet && browserDisposition(wallet)).toMatchObject({
      kind: "policy",
      authored: false,
    });
  });
});

it.each([
  ["1password", "onepassword-connect"],
  ["bitwarden", "bitwarden-api"],
  ["vaultwarden", "bitwarden-api"],
  ["bitwarden-sm", "bitwarden-secrets"],
  ["proton-pass", "file-import"],
])(
  "retires %s's generic refusal when its specialized adapter ships",
  (id, mode) => {
    expect(authoredDisposition(id)).toBeUndefined();
    expect(secretBackendPreset(id)?.modes).toContain(mode);
  },
);

describe("the kinds a tile can show", () => {
  it("has a label for every kind", () => {
    for (const kind of UNAVAILABLE_PRIORITY)
      expect(UNAVAILABLE_LABEL[kind], kind).toBeTruthy();
  });

  it("tells a person the most actionable reason first", () => {
    expect(leadingUnavailableKind(["no-contract", "refuses-browser"])).toBe(
      "refuses-browser",
    );
    expect(leadingUnavailableKind([undefined, "needs-client-secret"])).toBe(
      "needs-client-secret",
    );
    expect(leadingUnavailableKind([])).toBe("no-contract");
  });
});
