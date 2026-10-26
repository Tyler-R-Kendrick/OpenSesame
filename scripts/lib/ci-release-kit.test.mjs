// The release kit (ADR 0212): the workflow's shape, where its edits send CI,
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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { areasForPaths, repoRootFromHere } from "./ci-changed-areas.mjs";
import { driverReach, gatesForPath } from "./ci-gates.mjs";
import { readString } from "./json-boundary.mjs";

// The `yaml` package pnpm hoists privately, loaded the way
// scripts/security/verified-backports.mjs loads it.
const { parse } = createRequire(
  new URL("../../node_modules/.pnpm/node_modules/", import.meta.url),
)("yaml");

const root = repoRootFromHere();
const workflow = ".github/workflows/release-kit.yml";
const yaml = readFileSync(join(root, workflow), "utf8");
const script = join(root, "scripts/release/kit-archive.sh");
const guide = readFileSync(join(root, "docs/operators/release-kit.md"), "utf8");
const TEST_BUILD = "opensesame-surrogate-proxy-TEST-upstream-override";

/** A GitHub Actions expression, as it is written in the workflow. */
const expression = (body) => `\${{ ${body} }}`;

/** The text of one job, from its key to the next job's. */
function job(name) {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  expect(start, `no job ${name}`).toBeGreaterThan(-1);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The script of every `run:` step of every job, as the YAML parser reads it. */
function runScripts(text) {
  return Object.values(parse(text).jobs).flatMap((definition) =>
    (definition.steps ?? []).flatMap((step) => {
      const script = readString(step.run);
      return script === undefined ? [] : [script];
    }),
  );
}

// The structural gate counts each describe callback as one function of at most
// 100 lines, so the suite is several describes of the same name.
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
});

describe("release kit workflow", () => {
  it("checks the tag first, so a tag on any other commit builds nothing", () => {
    const tag = job("tag");
    expect(tag).toMatch(/permissions:\n {6}contents: read\n/);
    // Every branch's history, so origin/main is there to compare with.
    expect(tag).toContain("fetch-depth: 0");
    expect(tag).toContain(
      'scripts/release/tag-check.sh verify "$TAG" "$EVENT_SHA"',
    );
    expect(tag).toContain('scripts/release/tag-check.sh commit "$EVENT_SHA"');
    expect(tag).toContain(`sha: ${expression("steps.check.outputs.sha")}`);
    for (const name of ["bridge", "build"]) {
      expect(job(name), name).toMatch(/needs: .*\btag\b/);
    }
    // The comparison lives in that one job and one script, not in the later ones.
    expect(yaml.match(/merge-base/g) ?? []).toEqual([]);
    expect(job("checksums")).not.toContain("fetch-depth");
    // The tree each job builds is the commit that was checked.
    expect(job("build")).toContain(
      `VERIFIED_SHA: ${expression("needs.tag.outputs.sha")}`,
    );
    expect(job("build")).toContain(
      '[ "$(git rev-parse HEAD)" = "$VERIFIED_SHA" ]',
    );
  });

  it("never compares the raw GITHUB_SHA, which can be an annotated tag's object", () => {
    // Only the event's value is handed to tag-check.sh, which peels it.
    expect(yaml).not.toMatch(/\$\{?GITHUB_SHA\b/);
    expect(yaml).toContain(`EVENT_SHA: ${expression("github.sha")}`);
    expect(job("publish")).toContain(
      `VERIFIED_SHA: ${expression("needs.tag.outputs.sha")}`,
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
    expect(publish).toMatch(/needs: \[tag, checksums, attest\]/);
  });

  it("asks a reviewer before it publishes, when the owner has set one", () => {
    expect(job("publish")).toMatch(/environment:\n {6}name: release\n/);
    expect(guide).toContain("Settings › Environments › release");
  });
});

describe("release kit workflow", () => {
  it("attests every file, and SHA256SUMS too, with a pinned action", () => {
    const attest = job("attest");
    expect(attest).toMatch(
      /uses: actions\/attest-build-provenance@[a-f0-9]{40} # v\d/,
    );
    expect(attest).toContain("subject-checksums: dist/SHA256SUMS");
    // SHA256SUMS cannot list itself: its own statement, from its own step.
    expect(attest).toContain("subject-path: dist/SHA256SUMS");
    expect(attest.match(/attest-build-provenance@/g)).toHaveLength(2);
  });

  it("tells a downloader to check who signed it and from which tag", () => {
    const verify =
      "--signer-workflow Tyler-R-Kendrick/OpenSesame/.github/workflows/release-kit.yml";
    expect(guide).toContain(verify);
    expect(guide).toContain("--source-ref refs/tags/");
    // The same words in the release notes and the comment above the attest job.
    expect(yaml).toContain(
      "--signer-workflow $GH_REPO/.github/workflows/release-kit.yml",
    );
    expect(yaml).toContain("--source-ref refs/tags/$TAG");
    expect(yaml).toContain(verify);
    expect(yaml).toContain("--source-ref refs/tags/<tag>");
  });

  it("has no unpinned action, no pull_request_target and no expression in a script", () => {
    for (const [, action] of yaml.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      expect(action).toMatch(/^[\w./-]+@[a-f0-9]{40}$/);
    }
    expect(yaml).not.toContain("pull_request_target");
    const scripts = runScripts(yaml);
    expect(scripts.length).toBeGreaterThan(10);
    for (const body of scripts) expect(body).not.toContain("${{");
  });

  it("builds nothing that names this runner's checkout, and says what it cannot remap", () => {
    expect(job("build")).toContain(
      "--remap-path-prefix=$GITHUB_WORKSPACE=/opensesame",
    );
    // CARGO_MANIFEST_DIR is expanded by the compiler before the remap sees it.
    expect(yaml).toContain("except the compiled-in");
    expect(yaml).not.toContain("so the binaries do not name");
    expect(guide.replace(/\s+/g, " ")).toContain("except the compiled-in");
    expect(guide).not.toContain("paths remapped.");
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
    for (const path of [
      workflow,
      "scripts/release/kit-archive.sh",
      "scripts/release/tag-check.sh",
      "packages/env-spec-bridge/scripts/bundle.mjs",
    ]) {
      expect(gatesForPath(path, driverReach(root)), path).toEqual(new Set());
    }
  });
});

describe("release kit workflow", () => {
  it("reads a run script whole, continuation lines of a quoted scalar included", () => {
    const text = `jobs:\n  a:\n    steps:\n      - run: "echo one \\\n          ${expression("github.ref")}"\n`;
    expect(runScripts(text).join("")).toContain(expression("github.ref"));
  });

  it("keeps the files for as long as the approval can wait", () => {
    const kept = /name: release-files\n[\s\S]*?retention-days: (\d+)/.exec(
      job("checksums"),
    );
    expect(Number(kept?.[1])).toBeGreaterThanOrEqual(30);
  });

  it("verifies every attestation before it creates the release", () => {
    const publish = job("publish");
    expect(publish).not.toContain("attestations: read");
    expect(publish).toContain('--bundle "$2"');
    expect(publish).toContain(
      'verify_attestation "dist/$file" dist/release-files.sigstore.json',
    );
    expect(publish).toContain(
      "verify_attestation dist/SHA256SUMS dist/SHA256SUMS.sigstore.json",
    );
    expect(publish).toContain(
      '--signer-workflow "$GH_REPO/.github/workflows/release-kit.yml"',
    );
    expect(publish).toContain('--source-ref "refs/tags/$TAG"');
    const each = publish.indexOf('verify_attestation "dist/$file"');
    const sums = publish.indexOf("verify_attestation dist/SHA256SUMS");
    const create = publish.indexOf('gh release create "$TAG"');
    expect(each).toBeGreaterThan(-1);
    expect(sums).toBeGreaterThan(each);
    expect(create).toBeGreaterThan(sums);
  });

  it("calls the environment an approval step and the ruleset what keeps others from tagging", () => {
    const text = (value) => value.replace(/\s+/g, " ").replace(/# /g, "");
    expect(text(yaml)).toContain("an approval step, not a boundary");
    expect(text(guide)).toContain("an approval step, not a boundary");
    expect(text(guide)).toContain("Immutable releases");
    expect(text(guide)).not.toContain("cannot publish at all");
    expect(text(yaml)).not.toContain(
      "Only the owner may create a v* tag at all",
    );
  });
});

// The script uses GNU tar's --sort, --mtime and --owner; macOS ships bsdtar.
const gnuTar = /GNU tar/.test(
  spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "",
);

describe.skipIf(!gnuTar)(
  gnuTar
    ? "kit-archive.sh"
    : "kit-archive.sh (skipped: tar here is not GNU tar, which the script needs)",
  () => {
    let work;
    let bins;
    let bridge;
    const put = (name, text) => {
      writeFileSync(join(bins, name), text);
      chmodSync(join(bins, name), 0o755);
    };
    beforeAll(() => {
      work = mkdtempSync(join(tmpdir(), "kit-archive-"));
      bins = join(work, "bins");
      mkdirSync(bins);
      put("opensesame", "stand-in for opensesame\n");
      put("opensesame-surrogate-proxy", "plugin_not_active\n");
      put(TEST_BUILD, "OPENSESAME_SURROGATE_TEST_UPSTREAM\n");
      bridge = join(work, "opensesame-env-parse.mjs");
      writeFileSync(bridge, "#!/usr/bin/env node\n");
    });
    afterAll(() => rmSync(work, { recursive: true, force: true }));
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
  },
);
