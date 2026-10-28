import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const helper = "scripts/dev/install-cloud-cli.mjs";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { parse: parseYaml } = createRequire(
  new URL("../../node_modules/.pnpm/node_modules/", import.meta.url),
)("yaml");

function fixture(t, tool, payload) {
  const folder = mkdtempSync(join(tmpdir(), "cloud-tooling-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, "scripts/dev"), { recursive: true });
  mkdirSync(join(folder, ".cursor/tools"), { recursive: true });
  mkdirSync(join(folder, "bin"));
  copyFileSync(join(root, helper), join(folder, helper));
  writeFileSync(join(folder, "payload"), payload);
  writeFileSync(
    join(folder, ".cursor/tools/downloads.json"),
    JSON.stringify({
      [tool]: {
        version: "test-version",
        artifacts: {
          [`${process.platform}-${process.arch}`]: {
            url: "https://fixture.example/versioned-artifact",
            sha256: sha256(payload),
          },
        },
      },
    }),
  );
  writeFileSync(
    join(folder, "bin/curl"),
    `#!${process.execPath}
import { copyFileSync } from "node:fs";
if (process.env.CURL_FAIL) process.exit(22);
copyFileSync(process.env.PAYLOAD, process.argv[process.argv.indexOf("-o") + 1]);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(folder, "bin/tar"),
    '#!/bin/sh\nprintf "called\\n" >> "$TAR_TRACE"\nexec /usr/bin/tar "$@"\n',
    { mode: 0o755 },
  );
  const destination = join(folder, "installed", tool);
  return {
    folder,
    destination,
    run: (env = {}) =>
      spawnSync(process.execPath, [helper, tool, destination], {
        cwd: folder,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(folder, "bin")}:${process.env.PATH}`,
          PAYLOAD: join(folder, "payload"),
          TAR_TRACE: join(folder, "tar-trace"),
          ...env,
        },
      }),
  };
}

test("a verified Grok payload is installed with executable permissions", (t) => {
  const bytes = Buffer.from("#!/bin/sh\necho fixture\n");
  const f = fixture(t, "grok", bytes);
  const result = f.run();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(f.destination), bytes);
  assert.equal(statSync(f.destination).mode & 0o777, 0o755);
});

test("a tampered or failed download never replaces an installed binary", (t) => {
  const f = fixture(t, "grok", Buffer.from("expected"));
  mkdirSync(dirname(f.destination), { recursive: true });
  writeFileSync(f.destination, "previous version");
  writeFileSync(join(f.folder, "payload"), "tampered");
  for (const env of [{}, { CURL_FAIL: "1" }]) {
    const result = f.run(env);
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(f.destination, "utf8"), "previous version");
  }
});

test("Cursor archives are verified before extraction and keep the versioned entry point", (t) => {
  const source = mkdtempSync(join(tmpdir(), "cursor-archive-test-"));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  mkdirSync(join(source, "dist-package"));
  writeFileSync(join(source, "dist-package/cursor-agent"), "fixture", {
    mode: 0o755,
  });
  execFileSync("tar", [
    "-czf",
    join(source, "payload.tar.gz"),
    "-C",
    source,
    "dist-package",
  ]);
  const bytes = readFileSync(join(source, "payload.tar.gz"));
  const f = fixture(t, "cursor", bytes);
  writeFileSync(join(f.folder, "payload"), "tampered archive");
  const rejected = f.run();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Integrity mismatch/);
  assert.equal(existsSync(join(f.folder, "tar-trace")), false);
  assert.equal(existsSync(f.destination), false);
  writeFileSync(join(f.folder, "payload"), bytes);
  const accepted = f.run();
  assert.ifError(accepted.error);
  assert.equal(accepted.status, 0, accepted.stderr);
  const binary = join(f.destination, "test-version/cursor-agent");
  assert.equal(accepted.stdout.trim(), binary);
  assert.equal(readFileSync(binary, "utf8"), "fixture");
  assert.equal(statSync(binary).mode & 0o100, 0o100);
  assert.equal(readFileSync(join(f.folder, "tar-trace"), "utf8"), "called\n");
});

test("cloud CLI payloads and Kimi dependencies have committed integrity pins", () => {
  const downloads = JSON.parse(
    readFileSync(join(root, ".cursor/tools/downloads.json"), "utf8"),
  );
  for (const [tool, release] of Object.entries(downloads)) {
    for (const artifact of Object.values(release.artifacts)) {
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
      assert.ok(artifact.url.startsWith("https://"));
      assert.ok(artifact.url.includes(release.version), tool);
    }
    assert.ok(release.artifacts["linux-x64"]);
    assert.ok(release.artifacts["linux-arm64"]);
  }
  const lock = JSON.parse(
    readFileSync(join(root, ".cursor/tools/package-lock.json"), "utf8"),
  );
  assert.equal(
    lock.packages["node_modules/@moonshot-ai/kimi-code"].version,
    "2.1.1",
  );
  assert.equal(lock.packages[""].dependencies["node-pty"], "1.1.0");
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!name) continue;
    assert.match(pkg.integrity, /^sha512-/);
    assert.ok(pkg.resolved.startsWith("https://registry.npmjs.org/"));
  }
  const dockerfile = readFileSync(join(root, ".cursor/Dockerfile"), "utf8");
  assert.match(dockerfile, /npm ci --prefix \/opt\/opensesame-cloud-tools/);
  assert.match(dockerfile, /npm_config_nodedir=\/usr\/local/);
  assert.doesNotMatch(dockerfile, /curl[^\n]*\|\s*bash|npm install -g/);
});

test("published base images are pinned, while OSS Verify keeps its local builder contract", () => {
  for (const file of [
    ".cursor/Dockerfile",
    "ops/compose/Dockerfile",
    "tests/fuzz/clusterfuzzlite/Dockerfile",
  ]) {
    const text = readFileSync(join(root, file), "utf8");
    const bases = text.split("\n").filter((line) => line.startsWith("FROM "));
    assert.ok(bases.length > 0);
    for (const base of bases)
      assert.match(base, /@sha256:[a-f0-9]{64}(?: AS \w+)?$/);
  }
  const verify = readFileSync(
    join(root, "tests/fuzz/oss-verify/Dockerfile"),
    "utf8",
  );
  assert.match(verify, /ARG BASE_BUILDER=oss-verify-base-builder/);
  assert.match(verify, /FROM \$\{BASE_BUILDER\}/);
});

test("scheduled security scanning has no unnecessary issue write permission", () => {
  const text = readFileSync(
    join(root, ".github/workflows/security.yml"),
    "utf8",
  );
  assert.doesNotMatch(text, /issues:\s*write/);
  assert.match(text, /GITLEAKS_ENABLE_COMMENTS: "false"/);
  assert.match(text, /security-events: write/);
  assert.match(text, /id-token: write/);
});

test("scheduled native auditing fails closed on the real production graph after installing its locked runtime", () => {
  const workflow = parseYaml(
    readFileSync(join(root, ".github/workflows/security.yml"), "utf8"),
  );
  assert.ok(workflow.on.schedule.length > 0);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  const job = workflow.jobs["native-go"];
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.if, undefined);
  assert.equal(job.needs, undefined);
  const install = job.steps.findIndex((step) =>
    step.run?.startsWith("pnpm install "),
  );
  const audit = job.steps.findIndex(
    (step) =>
      step.run === "node tools/pwa-tailscale-native-http/native-audit.mjs",
  );
  assert.ok(install >= 0 && audit > install);
  assert.ok(job.steps[install].run.split(/\s+/).includes("--frozen-lockfile"));
  assert.ok(job.steps[install].run.split(/\s+/).includes("--ignore-scripts"));
  for (const step of job.steps) {
    assert.notEqual(step["continue-on-error"], true);
    assert.doesNotMatch(step.uses ?? "", /upload-artifact/);
  }
  assert.equal(job.steps[audit].if, undefined);
  assert.equal(job.steps[audit].env?.OPENSESAME_AUDIT_DIR, undefined);
  assert.ok(workflow.jobs["turn-crypto"]);
  assert.ok(workflow.jobs["osv-scanner"]);
});

function imageProfile(dockerfile, name) {
  const copied = dockerfile.match(
    new RegExp(`^COPY (\\.cursor/[^\\s]+) /etc/profile\\.d/${name}\\.sh$`, "m"),
  );
  if (copied) return readFileSync(join(root, copied[1]), "utf8");
  const generated = dockerfile.match(
    new RegExp(
      `RUN cat > /etc/profile\\.d/${name}\\.sh <<'EOF'\\n([\\s\\S]*?)\\nEOF`,
    ),
  );
  assert.ok(generated, `image must install its ${name} profile`);
  return generated[1];
}

function shellFixture(t) {
  const folder = mkdtempSync(join(tmpdir(), "cloud-shell-path-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const fixtureHome = join(folder, "different user home");
  const bin = join(folder, "bin");
  for (const dir of [
    bin,
    join(fixtureHome, ".local/bin"),
    join(folder, ".cursor"),
    join(folder, "scripts/dev"),
  ])
    mkdirSync(dir, { recursive: true });
  copyFileSync(
    join(root, ".cursor/install.sh"),
    join(folder, ".cursor/install.sh"),
  );
  if (existsSync(join(root, ".cursor/cloud-path.sh")))
    copyFileSync(
      join(root, ".cursor/cloud-path.sh"),
      join(folder, ".cursor/cloud-path.sh"),
    );
  for (const name of ["corepack", "cargo"])
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(
    join(folder, "scripts/dev/install-dependencies.sh"),
    "exit 0\n",
  );
  writeFileSync(
    join(folder, "scripts/dev/install-cloud-cli.mjs"),
    `
import {writeFileSync} from "node:fs";
writeFileSync("unexpected-redownload", "called");
throw new Error("an already installed Cursor must not be downloaded again");
`,
  );
  const binary = join(folder, "pinned-cursor-agent");
  writeFileSync(binary, "#!/bin/sh\nprintf 'fixture-cursor\\n'\n", {
    mode: 0o755,
  });
  for (const name of ["cursor-agent", "agent"])
    symlinkSync(binary, join(fixtureHome, ".local/bin", name));
  const dockerfile = readFileSync(join(root, ".cursor/Dockerfile"), "utf8");
  const profile = join(folder, "cargo.sh");
  const cloudProfile = join(folder, "kimi-code.sh");
  writeFileSync(cloudProfile, imageProfile(dockerfile, "kimi-code"));
  writeFileSync(
    profile,
    imageProfile(dockerfile, "cargo").replace(
      ". /etc/profile.d/kimi-code.sh",
      '. "$FIXTURE_CLOUD_PROFILE"',
    ),
  );
  const imagePath = dockerfile.match(/^ENV PATH=(.+)$/m)?.[1];
  assert.ok(imagePath);
  return {
    folder,
    fixtureHome,
    env: {
      ...process.env,
      HOME: fixtureHome,
      PATH: `${bin}:${imagePath}`,
      BASH_ENV: profile,
      FIXTURE_CLOUD_PROFILE: cloudProfile,
    },
  };
}

test("fresh non-login image shells find installed Cursor commands and bootstrap stays idempotent", (t) => {
  const f = shellFixture(t);
  const originalHome = process.env.HOME;
  const result = spawnSync(
    "/bin/bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      [
        "set -eu",
        "cursor-agent --version",
        "agent --version",
        "bash .cursor/install.sh",
        "bash .cursor/install.sh",
      ].join("\n"),
    ],
    { cwd: f.folder, env: f.env, encoding: "utf8" },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "fixture-cursor\nfixture-cursor\n");
  assert.equal(existsSync(join(f.folder, "unexpected-redownload")), false);
  const standaloneEnv = { ...f.env, BASH_ENV: undefined };
  const standalone = spawnSync(
    "/bin/bash",
    ["--noprofile", "--norc", ".cursor/install.sh"],
    {
      cwd: f.folder,
      env: standaloneEnv,
      encoding: "utf8",
    },
  );
  assert.ifError(standalone.error);
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.equal(existsSync(join(f.folder, "unexpected-redownload")), false);
  assert.equal(process.env.HOME, originalHome);
});
