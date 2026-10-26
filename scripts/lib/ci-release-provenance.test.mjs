// Promotion retains the verified original builder bundle as a release asset.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_PREDICATE, canonicalJson } from "../release/provenance.mjs";
import {
  hash,
  productAssets,
  releaseInventory,
  stageRelease,
} from "../release/stage-release.mjs";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { parse } = createRequire(
  new URL("../../node_modules/.pnpm/node_modules/", import.meta.url),
)("yaml");
const workflow = (name) =>
  parse(
    readFileSync(
      join(repoRootFromHere(), `.github/workflows/${name}.yml`),
      "utf8",
    ),
  );

describe("release provenance assets", () => {
  it("attests the original candidate separately from promotion and retires the tag builder", () => {
    const build = workflow("candidate-build").jobs.manifest;
    const attest = build.steps.find((step) =>
      step.uses?.startsWith("actions/attest@"),
    );
    expect(attest.with["predicate-type"]).toBe(BUILD_PREDICATE);
    expect(attest.with["subject-checksums"]).toBe("build-subjects.sha256");
    const upload = build.steps.find((step) => step.id === "upload");
    expect(upload.with.path).toBe("payload/");
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(upload.with["retention-days"]).toBeGreaterThanOrEqual(30);
    const promotion = workflow("release-publish").jobs.stage.steps.find(
      (step) => step.uses?.startsWith("actions/attest@"),
    );
    expect(promotion.with["subject-path"]).toBe("release-files/SHA256SUMS");
    expect(promotion.with["predicate-type"]).toBe(
      "https://opensesame.dev/attestations/release-promotion/v1",
    );
    expect(workflow("release-kit").jobs.attest).toBeUndefined();
    expect(workflow("release-kit").jobs.publish).toBeUndefined();
  });

  it("stages the verified builder signature unchanged and hashes its release representation", async () => {
    const work = mkdtempSync(join(tmpdir(), "release-bundles-"));
    try {
      const directory = join(work, "candidate");
      const evidence = join(work, "evidence");
      const output = join(work, "release");
      mkdirSync(directory);
      mkdirSync(evidence);
      const manifest = {
        version: "0.2.0",
        source_sha: "a".repeat(40),
        candidate_id: `${"a".repeat(40)}-100-1`,
        producer: {
          workflow_sha: "b".repeat(40),
          run_id: "100",
          run_attempt: "1",
        },
        source_ci: { run_id: "99", run_attempt: "1" },
        payloads: [],
      };
      for (const name of productAssets(manifest.version).filter(
        (name) => name !== "candidate.json",
      )) {
        const bytes = Buffer.from(`original:${name}`);
        writeFileSync(join(directory, name), bytes);
        manifest.payloads.push({
          path: name,
          sha256: hash(bytes),
          size: bytes.length,
        });
      }
      const bytes = Buffer.from(JSON.stringify(manifest));
      writeFileSync(join(directory, "candidate.json"), bytes);
      for (const name of ["dev", "prerelease", "mutation", "security"])
        writeFileSync(join(evidence, `${name}-receipt.json`), "{}");
      writeFileSync(join(evidence, "promotion.json"), "{}");
      // Encoded signed payload and signature strings must never be decoded or regenerated.
      const bundle = {
        dsseEnvelope: {
          payload: "c2lnbmVkLWJ1aWxk",
          signatures: [{ sig: "b3JpZ2luYWw=" }],
        },
        verificationMaterial: { certificate: { rawBytes: "Y2VydA==" } },
      };
      let calls = 0;
      await stageRelease({
        directory,
        evidence,
        output,
        repository: "owner/repo",
        token: "test",
        execute(command, args) {
          calls++;
          expect(command).toBe("gh");
          expect(args[args.indexOf("--signer-workflow") + 1]).toBe(
            "owner/repo/.github/workflows/candidate-build.yml",
          );
          return JSON.stringify([
            {
              attestation: { bundle },
              verificationResult: {
                statement: {
                  predicateType: BUILD_PREDICATE,
                  subject: [{ digest: { sha256: hash(bytes) } }],
                  predicate: { ...manifest, manifest_sha256: hash(bytes) },
                },
              },
            },
          ]);
        },
      });
      expect(calls).toBe(1);
      const retained = readFileSync(
        join(output, "build-provenance.sigstore.json"),
      );
      expect(retained.toString()).toBe(`${canonicalJson(bundle)}\n`);
      expect(JSON.parse(retained)).toEqual(bundle);
      expect(readFileSync(join(output, "SHA256SUMS"), "utf8")).toContain(
        `${hash(retained)}  build-provenance.sigstore.json\n`,
      );
      expect(
        releaseInventory(output, manifest).find(
          (asset) => asset.name === "build-provenance.sigstore.json",
        ).sha256,
      ).toBe(hash(retained));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
