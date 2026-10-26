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
const workflow = ".github/workflows/candidate-build.yml";
const yaml = readFileSync(join(root, workflow), "utf8");
const producer = parse(yaml);
const publisherText = readFileSync(
  join(root, ".github/workflows/release-publish.yml"),
  "utf8",
);
const publisher = parse(publisherText);
const script = join(root, "scripts/release/kit-archive.sh");
const guide = readFileSync(join(root, "docs/operators/release-kit.md"), "utf8");
const TEST_BUILD = "opensesame-surrogate-proxy-TEST-upstream-override";

function runScripts(text) {
  return Object.values(parse(text).jobs).flatMap((definition) =>
    (definition.steps ?? []).flatMap((step) => {
      const body = readString(step.run);
      return body === undefined ? [] : [body];
    }),
  );
}

const jobScripts = (definition) =>
  (definition.steps ?? []).map((step) => step.run ?? "").join("\n");

describe("candidate producer workflow", () => {
  it("builds only selected snapshots and requires exact successful fast-CI evidence", () => {
    expect(Object.keys(producer.on).sort()).toEqual([
      "workflow_call",
      "workflow_dispatch",
    ]);
    expect(Object.keys(producer.on.workflow_call.inputs).sort()).toEqual([
      "source_ci_run_attempt",
      "source_ci_run_id",
      "source_sha",
    ]);
    const resolve = jobScripts(producer.jobs.resolve);
    expect(resolve).toContain('[ "$GITHUB_REF" = refs/heads/main ]');
    expect(resolve).toContain(
      'git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main',
    );
    expect(resolve).toContain("'head_branch': 'main', 'event': 'push'");
    expect(resolve).toContain("'status': 'completed', 'conclusion': 'success'");
    expect(
      producer.jobs.resolve.steps.some(
        (step) => step.with?.["fetch-depth"] === 0,
      ),
    ).toBe(true);
  });

  it("separates trusted control code from selected application source", () => {
    for (const name of ["bridge", "pages", "native"]) {
      const checkouts = producer.jobs[name].steps.filter((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(
        checkouts.find((step) => step.with.path === ".ci-control").with.ref,
      ).toBe("${{ github.workflow_sha }}");
      expect(checkouts.find((step) => step.with.path === "src").with.ref).toBe(
        "${{ needs.resolve.outputs.source_sha }}",
      );
    }
  });

  it("copies shipped proxy bytes before building the separately named TEST variant", () => {
    const build = jobScripts(producer.jobs.native);
    expect(
      build.indexOf(
        "cp target/release/opensesame-surrogate-proxy bins/opensesame-surrogate-proxy\n",
      ),
    ).toBeLessThan(build.indexOf("--features upstream-override"));
    expect(build).toContain(`bins/${TEST_BUILD}`);
    expect(build).toContain(
      "--locked --release -p opensesame-cli --bin opensesame",
    );
    expect(
      producer.jobs.native.strategy.matrix.include
        .map((item) => item.target)
        .sort(),
    ).toEqual(["aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]);
    expect(build).toContain("smoke-kit.sh");
  });

  it("signs all exact payloads before making the candidate available", () => {
    const final = producer.jobs.manifest;
    expect(final.name).toBe("Candidate build gate");
    expect(final.permissions).toEqual({
      contents: "read",
      actions: "read",
      "id-token": "write",
      attestations: "write",
    });
    expect(jobScripts(final)).toContain("collect-build.mjs");
    expect(jobScripts(final)).toContain("build-manifest.py");
    const attest = final.steps.findIndex((step) =>
      step.uses?.startsWith("actions/attest@"),
    );
    const upload = final.steps.findIndex((step) => step.id === "upload");
    expect(attest).toBeGreaterThan(0);
    expect(upload).toBeGreaterThan(attest);
    expect(final.steps[attest].with["subject-checksums"]).toBe(
      "build-subjects.sha256",
    );
    expect(final.steps[attest].with["predicate-type"]).toBe(
      "https://opensesame.dev/attestations/candidate-build/v1",
    );
    expect(final.steps[upload].with["retention-days"]).toBeGreaterThanOrEqual(
      35,
    );
    expect(yaml).not.toContain("actions/download-artifact@");
  });
});

it("the candidate builder prepares Linux DBus through trusted rootless helpers before compiling the kit", () => {
  const native = producer.jobs.native;
  const control = native.steps.find(
    (step) => step.with?.path === ".ci-control",
  );
  expect(control.with["sparse-checkout"]).toContain("scripts/ci");
  const body = jobScripts(native);
  expect(body).toContain(
    'bash ../.ci-control/scripts/ci/prepare-dbus.sh "$RUNNER_TEMP/opensesame-dbus"',
  );
  expect(
    body.indexOf('source "$RUNNER_TEMP/opensesame-dbus/env.sh"'),
  ).toBeLessThan(body.indexOf("cargo +1.88.0 build --locked --release"));
  expect(body).not.toMatch(/sudo|apt-get install/);
});

describe("artifact publication workflow", () => {
  it("can only be called with the candidate and three qualification receipts", () => {
    expect(Object.keys(publisher.on)).toEqual(["workflow_call"]);
    expect(Object.keys(publisher.on.workflow_call.inputs)).toHaveLength(10);
    expect(publisher.permissions).toEqual({});
    expect(publisher.concurrency["cancel-in-progress"]).toBe(false);
    for (const job of Object.values(publisher.jobs))
      expect(jobScripts(job)).toContain("verify-promotion");
  });

  it("stages reviewable notes before one approval gates both products", () => {
    for (const name of ["stage", "publish"]) {
      expect(publisher.jobs[name].environment).toBeUndefined();
      expect(publisher.jobs[name].permissions.contents).toBe("write");
    }
    const approval = publisher.jobs.approval;
    expect(approval.needs).toBe("stage");
    expect(approval.environment).toEqual({
      name: "release",
      url: "${{ needs.stage.outputs.draft_url }}",
    });
    expect(approval.permissions).toEqual({
      contents: "read",
      actions: "read",
      attestations: "read",
    });
    expect(publisher.jobs.stage.outputs.draft_url).toBe(
      "${{ steps.draft.outputs.draft_url }}",
    );
    expect(publisher.jobs.pages.environment.name).toBe("github-pages");
    expect(publisher.jobs.pages.needs).toContain("approval");
    expect(publisher.jobs.publish.needs).toContain("approval");
    expect(publisher.jobs.publish.needs).toContain("pages");
    expect(jobScripts(publisher.jobs.stage)).toContain(
      "publish-release.mjs prepare",
    );
    expect(jobScripts(publisher.jobs.publish)).toContain(
      "publish-release.mjs publish",
    );
  });

  it("promotes the exact existing archive without source builds or stamping", () => {
    const bodies = runScripts(publisherText).join("\n");
    expect(bodies).not.toMatch(
      /cargo .*build|turbo .*build|pnpm .*build|pages-release\.mjs stamp/,
    );
    expect(bodies).toContain(
      'gzip -dc "$PAGES_ARCHIVE" > hosting/artifact.tar',
    );
    expect(bodies).toContain("downloadArtifact(");
    expect(bodies).toContain(
      "cmp hosting/artifact.tar hosting-checked/artifact.tar",
    );
    expect(bodies).toContain("verify-site.mjs");
    const sign = publisher.jobs.stage.steps.find((step) =>
      step.uses?.startsWith("actions/attest@"),
    );
    expect(sign.with["predicate-type"]).toBe(
      "https://opensesame.dev/attestations/release-promotion/v1",
    );
  });

  it("documents exact signer and main-ref verification plus draft-only recovery", () => {
    expect(guide).toContain("--signer-workflow");
    expect(guide).toContain("candidate-build.yml");
    expect(guide).toContain("release-publish.yml");
    expect(guide).toContain("--source-ref refs/heads/main");
    expect(guide).toContain("unpublished draft");
  });
});

describe("release workflow safety and routing", () => {
  it("pins every external action and keeps expressions out of shell bodies", () => {
    for (const text of [yaml, publisherText]) {
      for (const [, action] of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm))
        expect(action).toMatch(/^[\w./-]+@[a-f0-9]{40}$/);
      expect(text).not.toContain("pull_request_target");
      for (const body of runScripts(text)) expect(body).not.toContain("${{");
    }
  });

  it("routes native kit workflow and helper edits to TypeScript protocol checks", () => {
    expect(areasForPaths([workflow]).typescript).toBe(true);
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
