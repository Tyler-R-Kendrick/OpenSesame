import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
} from "@opensesame/os-domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildConsentReceipt } from "./consent.js";
import {
  parseConsentReceipt,
  parseDistributionContract,
} from "./documents-runtime.js";
import {
  parseInstallationSelection,
  parseInstancePolicy,
  parseVaultSelection,
  parseWorkspaceRestriction,
} from "./documents.js";
import {
  FIXTURE_CATALOG,
  FIXTURE_DISTRIBUTION,
  FIXTURE_INSTALLATION,
  FIXTURE_POLICIES,
  fixtureResolveInput,
} from "./fixtures.js";
import { resolveComposition } from "./resolve.js";

/** A document as a plain JSON object, the way it arrives at the boundary. */
function json<T>(value: T): JsonObject {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value));
  if (!isJsonObject(parsed)) throw new Error("fixture is not an object");
  return parsed;
}

function diagnostics(result: {
  ok: boolean;
  diagnostics?: readonly { code: string; path: string }[];
}) {
  return result.ok ? [] : (result.diagnostics ?? []);
}

describe("selection, vault, receipt and distribution parsers", () => {
  it("round-trip their fixtures", () => {
    const selection = parseInstallationSelection(json(FIXTURE_INSTALLATION));
    expect(selection.ok && selection.value).toEqual(FIXTURE_INSTALLATION);
    const vault = parseVaultSelection({
      schemaVersion: 1,
      kind: "VaultCapabilitySelection",
      instanceId: "fixture-family",
      installationId: "fixture-installation",
      vaultId: "tomb-1",
      revision: "v1",
      disabled: ["connectors.external"],
    });
    expect(vault.ok).toBe(true);
    const distribution = parseDistributionContract(json(FIXTURE_DISTRIBUTION));
    expect(distribution.ok && distribution.value).toEqual(FIXTURE_DISTRIBUTION);
    const plan = resolveComposition(
      fixtureResolveInput({
        instancePolicy: FIXTURE_POLICIES.family,
        installation: FIXTURE_INSTALLATION,
      }),
    );
    const receipt = buildConsentReceipt(
      plan,
      FIXTURE_CATALOG,
      "2026-09-22T00:00:00.000Z",
    );
    const parsed = parseConsentReceipt(json(receipt));
    expect(parsed.ok && parsed.value).toEqual(receipt);
  });

  it("rejects a receipt whose digest, roots or exposure are inconsistent", () => {
    const plan = resolveComposition(
      fixtureResolveInput({
        instancePolicy: FIXTURE_POLICIES.family,
        installation: FIXTURE_INSTALLATION,
      }),
    );
    const receipt = buildConsentReceipt(
      plan,
      FIXTURE_CATALOG,
      "2026-09-22T00:00:00.000Z",
    );
    expect(
      diagnostics(
        parseConsentReceipt({
          ...json(receipt),
          acceptedAt: "2026-09-23T00:00:00.000Z",
        }),
      ).map((d) => d.code),
    ).toContain("INVALID_DIGEST");
    expect(
      diagnostics(
        parseConsentReceipt({
          ...json(receipt),
          roots: [...receipt.roots, "telemetry.external"],
        }),
      ).map((d) => d.path),
    ).toContain(`roots[${receipt.roots.length}]`);
    expect(
      diagnostics(
        parseConsentReceipt({
          ...json(receipt),
          exposure: { ...receipt.exposure, "a.b": "nope" },
        }),
      ).map((d) => d.path),
    ).toContain("exposure.a.b");
  });

  it("rejects selections with overlapping sets, bad slots and bad choices", () => {
    const base = json(FIXTURE_INSTALLATION);
    expect(
      diagnostics(
        parseInstallationSelection({
          ...base,
          selectedOptional: ["identity.federation"],
        }),
      ).map((d) => d.path),
    ).toContain("selectedOptional[0]");
    expect(
      diagnostics(
        parseInstallationSelection({
          ...base,
          chosenAlternatives: { Transport: "sharing.drops" },
        }),
      ).map((d) => d.path),
    ).toContain("chosenAlternatives.Transport");
    expect(
      diagnostics(
        parseInstallationSelection({
          ...base,
          chosenAlternatives: { transport: "Sharing" },
        }),
      ).map((d) => d.path),
    ).toContain("chosenAlternatives.transport");
    expect(
      diagnostics(
        parseInstallationSelection({
          ...base,
          delivery: { prefetch: "all", offlineCache: "shell-only" },
        }),
      ).map((d) => d.path),
    ).toContain("delivery.prefetch");
  });

  it("rejects distribution contracts with malformed workers or modules", () => {
    const base = json(FIXTURE_DISTRIBUTION);
    expect(
      diagnostics(
        parseDistributionContract({ ...base, moduleIds: ["nope"] }),
      ).map((d) => d.path),
    ).toContain("moduleIds[0]");
    expect(
      diagnostics(
        parseDistributionContract({
          ...base,
          workerVariants: [
            { id: "push", scriptPath: "https://x/sw.js", satisfies: [] },
          ],
        }),
      ).map((d) => d.path),
    ).toContain("workerVariants[0].scriptPath");
    const variants: JsonValue[] = FIXTURE_DISTRIBUTION.workerVariants.map((v) =>
      json(v),
    );
    expect(
      diagnostics(
        parseDistributionContract({
          ...base,
          workerVariants: [
            ...variants,
            { id: "push", scriptPath: "b.js", satisfies: [] },
          ],
        }),
      ).map((d) => d.code),
    ).toContain("DUPLICATE_ID");
    expect(
      diagnostics(
        parseDistributionContract({ ...base, basePath: "OpenSesame" }),
      ).map((d) => d.path),
    ).toContain("basePath");
  });
});

describe("parser fuzz", () => {
  const parsers = [
    parseInstancePolicy,
    parseWorkspaceRestriction,
    parseInstallationSelection,
    parseVaultSelection,
    parseConsentReceipt,
    parseDistributionContract,
  ];

  it("never throws on arbitrary JSON and only fails closed", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        for (const parse of parsers) {
          const result = parse(value);
          expect(result.ok === true || result.ok === false).toBe(true);
          if (!result.ok) expect(result.diagnostics.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300, seed: 20260922 },
    );
  });

  it("never throws when fixture-shaped documents are mutated field by field", () => {
    const fixtures: JsonObject[] = [
      json(FIXTURE_POLICIES.family),
      json(FIXTURE_INSTALLATION),
      json(FIXTURE_DISTRIBUTION),
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...fixtures),
        fc.string({ minLength: 1, maxLength: 24 }),
        fc.jsonValue(),
        (doc, key, replacement) => {
          const mutated: JsonObject = { ...doc, [key]: replacement };
          for (const parse of parsers) {
            const result = parse(mutated);
            expect(result.ok === true || result.ok === false).toBe(true);
          }
        },
      ),
      { numRuns: 300, seed: 20260922 },
    );
  });
});
