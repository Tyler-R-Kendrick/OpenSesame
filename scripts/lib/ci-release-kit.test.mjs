// The release kit (ADR 0207): the workflow's shape, where its edits send CI,
// and the archive script's bytes.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { areasForPaths, repoRootFromHere } from "./ci-changed-areas.mjs";
import { driverReach, gatesForPath } from "./ci-gates.mjs";

const root = repoRootFromHere();
const workflow = ".github/workflows/release-kit.yml";
const yaml = readFileSync(join(root, workflow), "utf8");
const script = join(root, "scripts/release/kit-archive.sh");
const TEST_BUILD = "opensesame-surrogate-proxy-TEST-upstream-override";

/** The text of one job, from its key to the next job's. */
function job(name) {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  expect(start, `no job ${name}`).toBeGreaterThan(-1);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("release kit workflow", () => {
  it("runs on a v* tag, or by hand as a dry run, with no token by default", () => {
    expect(yaml).toMatch(
      /^on:\n {2}push:\n {4}tags: \["v\*"\]\n {2}workflow_dispatch:\n/m,
    );
    expect(yaml).toMatch(/^permissions: \{\}$/m);
    expect(yaml).not.toMatch(/secrets\./);
  });

  it("gives write only to the jobs that attest and publish, and only on a tag", () => {
    for (const name of ["bridge", "build", "checksums"]) {
      expect(job(name)).toMatch(/permissions:\n {6}contents: read\n/);
      expect(job(name)).not.toMatch(/: write/);
    }
    expect(job("attest")).toContain("id-token: write");
    expect(job("attest")).toContain("attestations: write");
    expect(job("attest")).not.toContain("contents: write");
    expect(job("publish")).toContain("contents: write");
    for (const name of ["attest", "publish"]) {
      expect(job(name)).toContain("if: github.event_name == 'push'");
    }
  });

  it("builds the shipped binaries, then the test plugin under its own name", () => {
    const build = job("build");
    const shipped = build.indexOf(
      "cp target/release/opensesame-surrogate-proxy bins/opensesame-surrogate-proxy\n",
    );
    const test = build.indexOf("--features upstream-override");
    expect(shipped).toBeGreaterThan(-1);
    expect(test).toBeGreaterThan(shipped);
    expect(build).toContain(
      `cp target/release/opensesame-surrogate-proxy bins/${TEST_BUILD}`,
    );
    expect(build).toContain(
      "--locked --release -p opensesame-cli --bin opensesame",
    );
    expect(build).toContain(
      "aarch64-unknown-linux-gnu, runner: ubuntu-24.04-arm",
    );
  });

  it("publishes a draft, at the verified commit, only while the tag still names it", () => {
    const publish = job("publish");
    const order = [
      "tag_unmoved\n",
      'gh release create "$TAG" dist/* --draft --verify-tag --target "$VERIFIED_SHA"',
      "tag_unmoved\n          gh release edit",
      'gh release edit "$TAG" --draft=false',
    ].map((text) => publish.indexOf(text));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(job("checksums")).toContain(
      'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
    );
  });

  it("attests every file SHA256SUMS names with a pinned action", () => {
    expect(job("attest")).toMatch(
      /uses: actions\/attest-build-provenance@[a-f0-9]{40} # v\d/,
    );
    expect(job("attest")).toContain("subject-checksums: dist/SHA256SUMS");
  });

  it("is a TypeScript-area workflow that starts no browser gate", () => {
    expect(areasForPaths([workflow])).toEqual({
      typescript: true,
      bundle: false,
      rust: false,
      mtls: false,
      push: false,
    });
    expect(areasForPaths(["scripts/release/kit-archive.sh"]).typescript).toBe(
      true,
    );
    expect(gatesForPath(workflow, driverReach(root))).toEqual(new Set());
  });
});

describe("kit-archive.sh", () => {
  const work = mkdtempSync(join(tmpdir(), "kit-archive-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const bins = join(work, "bins");
  mkdirSync(bins);
  const put = (name, text) => {
    writeFileSync(join(bins, name), text);
    chmodSync(join(bins, name), 0o755);
  };
  put("opensesame", "stand-in for opensesame\n");
  put("opensesame-surrogate-proxy", "plugin_not_active\n");
  put(TEST_BUILD, "OPENSESAME_SURROGATE_TEST_UPSTREAM\n");
  const bridge = join(work, "opensesame-env-parse.mjs");
  writeFileSync(bridge, "#!/usr/bin/env node\n");
  const env = { ...process.env, SOURCE_DATE_EPOCH: "1760000000" };
  const target = "x86_64-unknown-linux-gnu";

  const pack = (out, umask) =>
    spawnSync(
      "bash",
      [
        "-c",
        `umask ${umask} && exec "$0" "$@"`,
        script,
        "pack",
        "v0.1.0",
        target,
        bins,
        bridge,
        out,
      ],
      { env, encoding: "utf8" },
    );

  it("packs the same bytes twice, whatever the umask", () => {
    const outs = ["022", "077"].map((umask) => {
      const out = join(work, `out-${umask}`);
      expect(pack(out, umask).status).toBe(0);
      writeFileSync(
        join(out, "opensesame-env-parse.mjs"),
        readFileSync(bridge),
      );
      execFileSync("bash", [script, "sums", out], { env });
      return out;
    });
    const files = readdirSync(outs[0]).sort();
    expect(files).toEqual([
      "SHA256SUMS",
      "opensesame-env-parse.mjs",
      `opensesame-kit_v0.1.0_${target}.tar.gz`,
      `${TEST_BUILD}_v0.1.0_${target}.tar.gz`,
    ]);
    for (const file of files) {
      expect(readFileSync(join(outs[1], file))).toEqual(
        readFileSync(join(outs[0], file)),
      );
    }
    const listing = execFileSync(
      "tar",
      ["-tvzf", join(outs[0], `opensesame-kit_v0.1.0_${target}.tar.gz`)],
      { encoding: "utf8" },
    );
    expect(listing).toMatch(
      /^-rw-r--r-- 0\/0 .* opensesame-kit_v0\.1\.0_[^/]+\/opensesame-env-parse\.mjs$/m,
    );
    expect(listing).toMatch(
      /^-rwxr-xr-x 0\/0 .* opensesame-kit_v0\.1\.0_[^/]+\/opensesame$/m,
    );
    expect(listing).not.toContain(TEST_BUILD);
  });

  it("refuses a shipped plugin carrying the override, and a test build without it", () => {
    put("opensesame-surrogate-proxy", "OPENSESAME_SURROGATE_TEST_UPSTREAM\n");
    const shipped = pack(join(work, "refused-a"), "022");
    expect(shipped.status).toBe(2);
    expect(shipped.stderr).toContain("a test build is not shipped");
    put("opensesame-surrogate-proxy", "plugin_not_active\n");
    put(TEST_BUILD, "plugin_not_active\n");
    const test = pack(join(work, "refused-b"), "022");
    expect(test.status).toBe(2);
    expect(test.stderr).toContain("it is not the upstream-override build");
    put(TEST_BUILD, "OPENSESAME_SURROGATE_TEST_UPSTREAM\n");
  });
});
