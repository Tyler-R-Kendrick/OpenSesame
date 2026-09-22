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

describe("parseInstancePolicy", () => {
  it("round-trips the fixture policies", () => {
    for (const policy of [
      FIXTURE_POLICIES.family,
      FIXTURE_POLICIES.managedProhibited,
    ]) {
      const result = parseInstancePolicy(json(policy));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual(policy);
    }
  });

  it("MODEL-02: an id in two of required/optional/prohibited fails with the later path", () => {
    const doc = json({
      ...FIXTURE_POLICIES.family,
      capabilities: {
        default: "deny",
        required: ["identity.federation"],
        optional: ["connectors.external", "identity.federation"],
        prohibited: ["connectors.external"],
      },
    });
    const result = parseInstancePolicy(doc);
    expect(result.ok).toBe(false);
    const found = diagnostics(result);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CONFLICTING_SETS",
          path: "capabilities.optional[1]",
        }),
        expect.objectContaining({
          code: "CONFLICTING_SETS",
          path: "capabilities.prohibited[0]",
        }),
      ]),
    );
  });

  it("rejects a non-deny default, a foreign updates block, and unknown fields", () => {
    const base = json(FIXTURE_POLICIES.family);
    expect(
      diagnostics(
        parseInstancePolicy({
          ...base,
          capabilities: json({
            ...FIXTURE_POLICIES.family.capabilities,
            default: "allow",
          }),
        }),
      ).map((d) => d.path),
    ).toContain("capabilities.default");
    expect(
      diagnostics(
        parseInstancePolicy({
          ...base,
          updates: {
            unknownCapabilities: "allow",
            expandedExposure: "require-approval",
          },
        }),
      ).map((d) => d.path),
    ).toContain("updates.unknownCapabilities");
    expect(
      diagnostics(
        parseInstancePolicy({
          ...base,
          updates: {
            unknownCapabilities: "deny",
            expandedExposure: "require-approval",
            extra: 1,
          },
        }),
      ).map((d) => d.code),
    ).toContain("UNKNOWN_FIELD");
    expect(
      diagnostics(parseInstancePolicy({ ...base, telemetry: true })).map(
        (d) => d.path,
      ),
    ).toContain("telemetry");
    expect(
      diagnostics(
        parseInstancePolicy({
          ...base,
          network: {
            externalServices: "allow",
            allowedServiceOrigins: ["https://a", "https://a"],
          },
        }),
      ).map((d) => d.code),
    ).toContain("DUPLICATE_ID");
  });

  it("bounds ids, revisions and list sizes", () => {
    const base = json(FIXTURE_POLICIES.family);
    expect(
      diagnostics(parseInstancePolicy({ ...base, revision: "" })).map(
        (d) => d.path,
      ),
    ).toContain("revision");
    expect(
      diagnostics(
        parseInstancePolicy({ ...base, revision: "r".repeat(65) }),
      ).map((d) => d.path),
    ).toContain("revision");
    expect(
      diagnostics(parseInstancePolicy({ ...base, instanceId: "bad id" })).map(
        (d) => d.code,
      ),
    ).toContain("INVALID_ID");
    const tooMany = Array.from({ length: 257 }, (_, i) => `a.c${i}`);
    expect(
      diagnostics(
        parseInstancePolicy({
          ...base,
          capabilities: {
            default: "deny",
            required: [],
            optional: tooMany,
            prohibited: [],
          },
        }),
      ).map((d) => d.code),
    ).toContain("TOO_MANY_ITEMS");
    expect(
      diagnostics(
        parseInstancePolicy({
          ...base,
          capabilities: {
            default: "deny",
            required: [],
            optional: ["a.b", "a.b"],
            prohibited: [],
          },
        }),
      ).map((d) => d.path),
    ).toContain("capabilities.optional[1]");
  });
});

const NO_IDS: string[] = [];

describe("parseWorkspaceRestriction", () => {
  const base = {
    schemaVersion: 1 as const,
    kind: "WorkspaceCapabilityRestriction" as const,
    instanceId: "fixture-family",
    vaultId: "tomb-1",
    revision: "w1",
    prohibited: NO_IDS,
  };

  it("MODEL-03: preserves allow: null and allow: [] as distinct values", () => {
    const inherit = parseWorkspaceRestriction({ ...base, allow: null });
    const none = parseWorkspaceRestriction({ ...base, allow: [] });
    expect(inherit.ok && inherit.value.allow).toBeNull();
    expect(none.ok && none.value.allow).toEqual([]);
    expect(parseWorkspaceRestriction(base).ok).toBe(false);
  });

  it("MODEL-03: allow: null inherits the ceiling; allow: [] permits no optional capability", () => {
    const input = fixtureResolveInput({
      instancePolicy: FIXTURE_POLICIES.family,
      provenance: "same-origin-deployment",
      installation: FIXTURE_INSTALLATION,
      vaultId: "tomb-1",
    });
    const inherit = resolveComposition({
      ...input,
      workspace: { ...base, allow: null },
    });
    const none = resolveComposition({
      ...input,
      workspace: { ...base, allow: [] },
    });
    expect(inherit.capabilities["connectors.external"]?.permitted).toBe(true);
    expect(inherit.capabilities["connectors.external"]?.reasons).toEqual([
      "CONSENT_REQUIRED",
    ]);
    expect(none.capabilities["connectors.external"]?.permitted).toBe(false);
    expect(none.capabilities["connectors.external"]?.reasons).toContain(
      "DENIED_BY_WORKSPACE",
    );
    expect(none.approvedCapabilities).toEqual([
      "settings.core",
      "vault.passwords",
    ]);
  });

  it("rejects an id in both allow and prohibited", () => {
    const result = parseWorkspaceRestriction({
      ...base,
      allow: ["a.b"],
      prohibited: ["a.b"],
    });
    expect(diagnostics(result)).toEqual([
      expect.objectContaining({
        code: "CONFLICTING_SETS",
        path: "prohibited[0]",
      }),
    ]);
  });
});

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
