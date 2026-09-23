/**
 * REDTEAM-E: Terminology / false-claim review against shipped assurances.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DURESS_ATTACK_TREES,
  findForbiddenClaims,
} from "@opensesame/contracts";
import { describe, expect, it } from "vitest";
import { recordCanaryHit } from "../canary/detect.js";
import { executeLocalRemoval } from "../removal/local-remove.js";

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../",
);

describe("REDTEAM-E terminology", () => {
  it("attack tree catalog is non-empty", () => {
    expect(DURESS_ATTACK_TREES.length).toBeGreaterThanOrEqual(10);
  });

  it("removal receipt never claims forensic erase", async () => {
    const receipt = await executeLocalRemoval(
      {
        version: 1,
        incidentId: "i1",
        vaultRef: "v1",
        deviceBindingRef: "d1",
        resources: [
          {
            ref: "c1",
            kind: "cache",
            storagePath: "vaults/v1/caches/c1",
          },
        ],
        preserveSealedOutbox: false,
        acceptUnrecoverability: true,
      },
      {
        async delete() {
          return true;
        },
        async exists() {
          return false;
        },
      },
    );
    expect(receipt.assurance).toBe("application_scoped_removal");
    expect(JSON.stringify(receipt)).not.toMatch(
      /forensic|secure delete|unrecoverable from disk/i,
    );
  });

  it("canary results are detection_only", () => {
    const hit = recordCanaryHit({
      canaryId: "c1",
      detectedAt: new Date().toISOString(),
    });
    expect(hit.kind).toBe("detection_only");
  });

  it("security-review + operator docs avoid forbidden affirmative claims", () => {
    const paths = [
      "docs/evidence/2026-09-21-duress/security-review.md",
      "docs/operators/duress-profiles.md",
      "docs/evidence/2026-09-21-duress/limitations.md",
    ];
    for (const rel of paths) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      const affirmative = text
        .split("\n")
        .filter(
          (line) =>
            !/why rejected|must not|never claim|not imply|rejected/i.test(line),
        )
        .join("\n");
      const hits = findForbiddenClaims(affirmative);
      expect(hits, rel).toEqual([]);
    }
  });

  it("detector flags known-bad marketing copy", () => {
    const hits = findForbiddenClaims(
      "Our decoy is indistinguishable from production vault and is safe from coercion.",
    );
    expect(hits.map((h) => h.id)).toEqual(
      expect.arrayContaining(["TERM-DECOY-FORGE", "TERM-SAFE-COERCION"]),
    );
  });
});
