import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderBrowserDispositions } from "../../scripts/emit-browser-dispositions.mjs";
import {
  AUTHORED_KINDS,
  type DispositionProbe,
  UNAVAILABLE_LABEL,
  UNAVAILABLE_PRIORITY,
  auditedOrigin,
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

const spec = () => browserDispositionSpec();
const admits = (probe: { allow_origin: string | null }) =>
  probe.allow_origin === "*" || probe.allow_origin === auditedOrigin();

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
    expect(BROWSER_DISPOSITIONS_JSON).toBe(JSON.stringify(source));
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
    for (const id of authoredDispositionIds())
      expect(
        hasConnectPlan(id),
        `${id} has a plan; browser-policy.json owns it`,
      ).toBe(false);
  });

  it("defines every kind a row may use, and no more", () => {
    expect(Object.keys(spec().kinds).sort()).toEqual(
      [...AUTHORED_KINDS].sort(),
    );
    for (const kind of AUTHORED_KINDS)
      expect(UNAVAILABLE_LABEL[kind]).toBeTruthy();
  });

  it("names its probes' origin and keeps every address https", () => {
    expect(auditedOrigin()).toBe("https://tyler-r-kendrick.github.io");
    for (const row of spec().dispositions) {
      for (const link of row.sources)
        expect(link.url, `${row.provider_id} source`).toMatch(/^https:\/\//);
      for (const probe of row.probes) {
        expect(probe.url, `${row.provider_id} probe`).toMatch(/^https:\/\//);
        expect(probe.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    }
  });
});

describe("what each kind must be able to prove", () => {
  const rows = () => spec().dispositions;
  const own = (row: { probes: readonly DispositionProbe[] }) =>
    row.probes.filter((probe) => probe.origin === undefined);

  it("a refusal rests on a response that did not admit this origin", () => {
    for (const row of rows().filter((r) => r.kind === "refuses-browser")) {
      const refused = own(row).filter(
        (probe) => probe.status >= 200 && probe.status < 300 && !admits(probe),
      );
      expect(
        refused.length,
        `${row.provider_id} needs a 2xx probe that did not admit the origin`,
      ).toBeGreaterThan(0);
    }
  });

  it("a pending driver rests on a response that admitted this origin", () => {
    for (const row of rows().filter((r) => r.kind === "driver-pending")) {
      expect(
        own(row).some((probe) => probe.status < 300 && admits(probe)),
        `${row.provider_id} needs a probe that admitted the origin`,
      ).toBe(true);
    }
  });

  it("'no way to check a key' rests on a public answer that admitted this origin", () => {
    for (const row of rows().filter((r) => r.kind === "no-key-check")) {
      expect(
        own(row).some(
          (probe) =>
            probe.stage === "unauthenticated-get" &&
            probe.status === 200 &&
            admits(probe),
        ),
        `${row.provider_id} needs an unauthenticated 200 that admitted the origin`,
      ).toBe(true);
    }
  });

  it("a companion, a built-in or a policy cites a page that backs it", () => {
    for (const row of rows().filter((r) =>
      ["companion", "built-in", "policy"].includes(r.kind),
    ))
      expect(row.sources.length, row.provider_id).toBeGreaterThan(0);
  });

  it("never states a refusal from a probe that disagrees with an admission of the same address", () => {
    for (const row of rows()) {
      const bySite = new Map<string, boolean[]>();
      for (const probe of own(row)) {
        const key = `${probe.stage}:${probe.url}`;
        bySite.set(key, [...(bySite.get(key) ?? []), admits(probe)]);
      }
      for (const [site, results] of bySite)
        expect(new Set(results).size, `${row.provider_id} ${site}`).toBe(1);
    }
  });
});

describe("every provider without a road gets an honest statement", () => {
  const roadless = catalogProviders().filter(
    (provider) => !hasConnectPlan(provider.id),
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

describe("Bitwarden, which the catch-all got wrong", () => {
  const bitwarden = catalogProvider("bitwarden");
  const disposition = bitwarden && browserDisposition(bitwarden);

  it("says what Bitwarden's two APIs are, and that one is a local CLI server", () => {
    expect(disposition?.kind).toBe("companion");
    expect(disposition?.summary).toContain("bw serve");
    expect(disposition?.summary).toContain("Origin header");
    expect(disposition?.summary).toContain("Public API manages organizations");
  });

  it("is backed by Bitwarden's own documentation and by a control probe", () => {
    expect(
      disposition?.sources.map((link) => new URL(link.url).hostname),
    ).toEqual(["bitwarden.com", "bitwarden.com"]);
    const probes = disposition?.probes ?? [];
    const refused = probes.filter((p) => p.origin === undefined);
    const control = probes.filter((p) => p.origin !== undefined);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((p) => !admits(p))).toBe(true);
    // The same requests from Bitwarden's own origin are admitted: an allow-list.
    expect(control.length).toBe(refused.length);
    expect(control.every((p) => p.allow_origin === p.origin)).toBe(true);
  });

  it("offers the route that works today", () => {
    expect(disposition?.alternative).toEqual({
      label: "Open Vault to import a supported export",
      to: "/vault?f=all",
    });
  });
});

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
