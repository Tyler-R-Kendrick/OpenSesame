import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CompilerErrorCodeSchema } from "./evidence.js";
import {
  type CompilerCatalog,
  type CompilerErrorCode,
  PolicyDocumentSchema,
  SCENARIO_IDS,
  compileDuressPolicy,
  importDuressPolicyPreview,
  roundTripDuressPolicy,
} from "./index.js";
import { INVALID_FIXTURES } from "./invalid-fixtures.js";

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), "testdata");

const catalog: CompilerCatalog = {
  ownerPrincipalRefs: ["owner-1"],
  organizationRefs: ["org-1"],
  vaultRefs: ["vault-1"],
  deviceBindingRefs: ["device-1", "device-retired"],
  compartmentRefs: [
    "comp-normal",
    "comp-decoy",
    "comp-restricted",
    "comp-carry",
  ],
  independentCompartmentRefs: ["comp-decoy", "comp-restricted", "comp-carry"],
  routeRefs: ["route-alert-1"],
  peerRefs: ["peer-1"],
  providerActionRefs: [],
  recoveryPolicyRefs: ["recovery-1", "recovery-cycle-a", "recovery-cycle-b"],
  operationCeilingRefs: ["ceiling-restricted", "ceiling-carry"],
  authorityRefs: ["host-authority-1"],
  durableStorage: true,
  alternateUnlockPaths: [],
  retiredDeviceBindingRefs: ["device-retired"],
  recoveryEdges: [
    {
      fromPolicyRef: "recovery-cycle-a",
      dependsOnPolicyRef: "recovery-cycle-b",
    },
    {
      fromPolicyRef: "recovery-cycle-b",
      dependsOnPolicyRef: "recovery-cycle-a",
    },
  ],
};

beforeAll(() => {
  mkdirSync(join(EXAMPLES, "invalid"), { recursive: true });
  for (const code of CompilerErrorCodeSchema.options) {
    const document = INVALID_FIXTURES[code];
    writeFileSync(
      join(EXAMPLES, "invalid", `${code}.json`),
      `${JSON.stringify({ expectedError: code, document }, null, 2)}\n`,
    );
  }
});

describe("scenario fixtures", () => {
  it.each([...SCENARIO_IDS])("%s validates and compiles", (id) => {
    const raw = readFileSync(join(EXAMPLES, "scenarios", `${id}.json`), "utf8");
    const doc = PolicyDocumentSchema.parse(JSON.parse(raw));
    const result = compileDuressPolicy(doc, catalog);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.armed).toBe(false);
    const yamlRound = roundTripDuressPolicy(doc, "yaml");
    const jsonRound = roundTripDuressPolicy(doc, "json");
    expect(yamlRound.policyId).toBe(doc.policyId);
    expect(jsonRound.revision).toBe(doc.revision);
  });
});

describe("invalid fixtures", () => {
  it.each(CompilerErrorCodeSchema.options)(
    "rejects with %s",
    (code: CompilerErrorCode) => {
      const document = INVALID_FIXTURES[code];
      expect(document).toBeDefined();

      let cat: CompilerCatalog = { ...catalog };
      if (code === "stale_policy") {
        cat = { ...cat, minPolicyRevision: 99 };
      }
      if (code === "stale_session") {
        cat = {
          ...cat,
          expectedSessionDigest: "sha256:aaaaaaaaaaaaaaaa",
          presentedSessionDigest: "sha256:bbbbbbbbbbbbbbbb",
        };
      }
      if (code === "alternate_unlock_bypass") {
        cat = {
          ...cat,
          alternateUnlockPaths: [
            { label: "legacy-password", bypassesClaim: true },
          ],
        };
      }
      if (code === "undurable_storage") {
        cat = { ...cat, durableStorage: false };
      }

      const result = compileDuressPolicy(document, cat);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.diagnostics.some((d) => d.code === code),
          JSON.stringify(result.diagnostics),
        ).toBe(true);
      }
    },
  );
});

describe("import preview", () => {
  it("strips secrets and never arms", () => {
    const yaml = readFileSync(
      join(EXAMPLES, "scenarios", "SC-ALERT-ONLY.yaml"),
      "utf8",
    );
    const poisoned = `${yaml}\ntriggerSecret: hunter2\n`;
    const preview = importDuressPolicyPreview(poisoned, "yaml", catalog);
    expect(preview.armed).toBe(false);
    expect(preview.cleared).toBe(false);
    expect(preview.strippedSecretKeys).toContain("triggerSecret");
    expect(preview.dryRun.wouldArm).toBe(false);
  });
});

describe("examples directory coverage", () => {
  it("has yaml+json for every scenario", () => {
    const files = readdirSync(join(EXAMPLES, "scenarios"));
    for (const id of SCENARIO_IDS) {
      expect(files).toContain(`${id}.json`);
      expect(files).toContain(`${id}.yaml`);
    }
  });

  it("writes invalid fixtures for every compiler error", () => {
    for (const code of CompilerErrorCodeSchema.options) {
      expect(existsSync(join(EXAMPLES, "invalid", `${code}.json`))).toBe(true);
    }
  });
});
