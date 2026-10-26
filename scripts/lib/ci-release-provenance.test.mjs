// Release assets preserve the original signed bundles emitted by GitHub Actions.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const { parse } = createRequire(
  new URL("../../node_modules/.pnpm/node_modules/", import.meta.url),
)("yaml");
const yaml = readFileSync(
  join(repoRootFromHere(), ".github/workflows/release-kit.yml"),
  "utf8",
);
const expression = (body) => `\${{ ${body} }}`;

describe("release provenance assets", () => {
  it("publishes the action's original bundles and preserves their bytes", () => {
    const jobs = parse(yaml).jobs;
    const steps = jobs.attest.steps;
    const bundle = steps.find((step) => step.env?.FILES_BUNDLE);
    expect(bundle.env.FILES_BUNDLE).toBe(
      expression("steps.files.outputs.bundle-path"),
    );
    expect(bundle.env.SUMS_BUNDLE).toBe(
      expression("steps.sums.outputs.bundle-path"),
    );
    for (const id of ["files", "sums"]) {
      expect(steps.find((step) => step.id === id).uses).toMatch(
        /^actions\/attest-build-provenance@/,
      );
    }
    const upload = steps.find(
      (step) => step.with?.name === "release-provenance",
    );
    expect(upload.with.path).toBe("provenance/*.sigstore.json");
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(upload.with["retention-days"]).toBeGreaterThanOrEqual(30);
    const download = jobs.publish.steps.find(
      (step) => step.with?.name === "release-provenance",
    );
    expect(download.with.path).toBe("dist");
    const work = mkdtempSync(join(tmpdir(), "release-bundles-"));
    try {
      for (const name of ["files", "sums"]) {
        writeFileSync(join(work, name), JSON.stringify({ signedBundle: name }));
      }
      execFileSync("bash", ["-c", bundle.run], {
        cwd: work,
        stdio: "inherit",
        env: {
          ...process.env,
          FILES_BUNDLE: join(work, "files"),
          SUMS_BUNDLE: join(work, "sums"),
        },
      });
      for (const [source, target] of [
        ["files", "release-files.sigstore.json"],
        ["sums", "SHA256SUMS.sigstore.json"],
      ]) {
        expect(readFileSync(join(work, "provenance", target))).toEqual(
          readFileSync(join(work, source)),
        );
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
