/**
 * The evidence behind every authored disposition (ADR 0197). A browser ships
 * the reasons and not this: the probes live in the spec for these tests and for
 * `pnpm audit:browser-dispositions`, so they cost the bundle nothing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AUTHORED_KINDS,
  DISPOSITION_ROUTES,
  browserDisposition,
} from "./browser-disposition.js";
import { catalogProvider } from "./connector-catalog.js";

const probeSchema = z
  .object({
    stage: z.enum([
      "preflight",
      "unauthenticated-get",
      "unauthenticated-post",
      "authenticated-invalid-key",
    ]),
    url: z.string().url(),
    method: z.enum(["GET", "POST"]),
    request_header_names: z.array(z.string()),
    status: z.number().int(),
    allow_origin: z.string().nullable(),
    allow_methods: z.string().nullable(),
    allow_headers: z.string().nullable(),
    checked_at: z.string(),
    /** Set when a probe came from a different origin, as a control. */
    origin: z.string().url().optional(),
    note: z.string().optional(),
  })
  .strict();

const linkSchema = z
  .object({ label: z.string().min(1), url: z.string().url() })
  .strict();

const evidenceSchema = z
  .object({
    schema_version: z.literal(1),
    audited_origin: z.string().url(),
    checked_date: z.string(),
    qualification: z.string().min(1),
    kinds: z.record(z.string(), z.string()),
    dispositions: z.array(
      z
        .object({
          provider_id: z.string().min(1),
          kind: z.enum(AUTHORED_KINDS),
          summary: z.string().min(1),
          sources: z.array(linkSchema),
          probes: z.array(probeSchema),
          alternative: z
            .object({
              label: z.string().min(1),
              to: z.enum(DISPOSITION_ROUTES),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

type Probe = z.infer<typeof probeSchema>;

const evidence = evidenceSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../../spec/connectors/browser-dispositions.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const rows = evidence.dispositions;
const admits = (probe: Probe) =>
  probe.allow_origin === "*" || probe.allow_origin === evidence.audited_origin;
const own = (row: { probes: readonly Probe[] }) =>
  row.probes.filter((probe) => probe.origin === undefined);

describe("the evidence file", () => {
  it("defines every kind a row may use, and no more", () => {
    expect(Object.keys(evidence.kinds).sort()).toEqual(
      [...AUTHORED_KINDS].sort(),
    );
  });

  it("keeps every probe address https and every check dated", () => {
    for (const row of rows)
      for (const probe of row.probes) {
        expect(probe.url, `${row.provider_id} probe`).toMatch(/^https:\/\//);
        expect(probe.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
  });
});

describe("what each kind must be able to prove", () => {
  it("a refusal rests on a response that did not admit this origin", () => {
    for (const row of rows.filter((r) => r.kind === "refuses-browser")) {
      // A successful answer, or the refusal of a bad key, that a page cannot read.
      const refused = own(row).filter(
        (probe) =>
          !admits(probe) &&
          ((probe.status >= 200 && probe.status < 300) ||
            (probe.stage === "authenticated-invalid-key" &&
              [401, 403].includes(probe.status))),
      );
      expect(
        refused.length,
        `${row.provider_id} needs a 2xx answer or a bad-key refusal that did not admit the origin`,
      ).toBeGreaterThan(0);
    }
  });

  it("a pending driver rests on a response that admitted this origin", () => {
    for (const row of rows.filter((r) => r.kind === "driver-pending")) {
      expect(
        own(row).some((probe) => probe.status < 300 && admits(probe)),
        `${row.provider_id} needs a probe that admitted the origin`,
      ).toBe(true);
    }
  });

  it("'no way to check a key' rests on a public answer that admitted this origin", () => {
    for (const row of rows.filter((r) => r.kind === "no-key-check")) {
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
    for (const row of rows.filter((r) =>
      ["companion", "built-in", "policy"].includes(r.kind),
    ))
      expect(row.sources.length, row.provider_id).toBeGreaterThan(0);
  });

  it("never states a refusal from a probe that disagrees with an admission of the same address", () => {
    for (const row of rows) {
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

describe("the row a browser reads is the row the evidence backs", () => {
  it("says the same thing for every authored provider", () => {
    for (const row of rows) {
      const provider = catalogProvider(row.provider_id);
      expect(provider, row.provider_id).toBeDefined();
      if (!provider) continue;
      expect(browserDisposition(provider)).toMatchObject({
        kind: row.kind,
        summary: row.summary,
        sources: row.sources,
        authored: true,
      });
    }
  });

  it("backs Bitwarden's refusal with a control from Bitwarden's own origin", () => {
    const bitwarden = rows.find((row) => row.provider_id === "bitwarden");
    const probes = bitwarden?.probes ?? [];
    const refused = probes.filter((probe) => probe.origin === undefined);
    const control = probes.filter((probe) => probe.origin !== undefined);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((probe) => !admits(probe))).toBe(true);
    // The same requests from Bitwarden's own origin are admitted: an allow-list.
    expect(control.length).toBe(refused.length);
    expect(control.every((probe) => probe.allow_origin === probe.origin)).toBe(
      true,
    );
  });
});
