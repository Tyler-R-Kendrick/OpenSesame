import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  CONTROLLED_ORIGIN,
  deploymentProof,
} from "./controlled-security-deployment.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function emitted(profile, canonicalOrigin) {
  const directory = mkdtempSync(join(tmpdir(), "os-deployment-proof-"));
  directories.push(directory);
  writeFileSync(join(directory, "index.html"), "public shell");
  writeFileSync(
    join(directory, "security-profile.json"),
    JSON.stringify({
      version: 1,
      profile,
      canonicalOrigin,
    }),
  );
  return directory;
}

it("refuses a missing isolated deployment instead of testing the standard shell as a positive", () => {
  const directory = emitted(
    "shared_origin_demo",
    "https://tyler-r-kendrick.github.io",
  );
  expect(() =>
    deploymentProof(directory, "loopback_development", CONTROLLED_ORIGIN),
  ).toThrow();
});

it("refuses a loopback deployment compiled for a different origin", () => {
  const directory = emitted("loopback_development", "http://localhost:41877");
  expect(() =>
    deploymentProof(directory, "loopback_development", CONTROLLED_ORIGIN),
  ).toThrow();
});

it("records the actual emitted deployment and files only at its compiled canonical origin", () => {
  const directory = emitted("loopback_development", CONTROLLED_ORIGIN);
  const proof = deploymentProof(
    directory,
    "loopback_development",
    CONTROLLED_ORIGIN,
  );
  expect(proof.canonicalOrigin).toBe(CONTROLLED_ORIGIN);
  expect(proof.buildIndexSha256).toHaveLength(64);
  expect(proof.artifactSizes.files).toBe(2);
  expect(proof.artifactSizes.bytes).toBeGreaterThan(12);
});
