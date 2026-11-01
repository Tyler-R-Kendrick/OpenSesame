import assert from "node:assert/strict";
import test from "node:test";
import { GitHub, policyEntriesForTree } from "./lib/candidate-api.mjs";
import { CI_RECIPE, POLICY } from "./lib/candidate-policy.mjs";

test("scanner configuration, ignores and helpers are part of policy compatibility", async () => {
  const policies = [
    ".github/codeql/codeql-config.yml",
    ".github/codeql/custom/queries.qls",
    ".gitleaks.toml",
    ".gitleaksignore",
    ".osv-scanner.toml",
    ".cargo/audit.toml",
    ".cargo/config.toml",
    "deny.toml",
    "osv-scanner.toml",
    ".semgrepignore",
    ".semgrep/rules.yml",
    "apps/.semgrepignore",
    ".gitignore",
    "apps/.gitignore",
    ".ignore",
    "apps/.rgignore",
    "sgconfig.yml",
    "apps/sgconfig.yaml",
    "scripts/lib/audit-directory.sh",
    "scripts/lib/dependency-compatibility.test.mjs",
    "scripts/fuzz/jazzer-gate.sh",
    "scripts/lib/fuzz-directory.sh",
    "scripts/security/map-composed-go-sarif.mjs",
    "scripts/audit/native-toolchain-sbom.py",
    "scripts/audit/new-helper.py",
    "scripts/test/live-turn/audit-crypto.sh",
    "scripts/test/live-turn/verify-crypto-subset.py",
    "scripts/test/live-turn/new-helper.py",
    "tools/pwa-tailscale-native-http/source.json",
    "packages/app-core/scripts/sops-oracle/oracle.mjs",
    "apps/android/scripts/build-core.sh",
    "crates/authenticator-core/src/bin/uniffi-bindgen.rs",
    "crates/authenticator-core/src/lib.rs",
    "crates/authenticator-core/src/new-boundary.rs",
    "apps/android/scripts/new-build-helper.py",
    "apps/android/scripts/required.test.sh",
    "packages/app-core/scripts/sops-oracle/runtime.test.mjs",
    "tools/pwa-tailscale-native-http/runtime.test.mjs",
    "apps/android/android/settings.gradle.kts",
    "apps/android/android/build.gradle.kts",
    "apps/android/android/app/build.gradle.kts",
    "apps/android/android/gradle.properties",
    "apps/android/android/app/new.gradle.kts",
    "apps/android/android/buildSrc/src/main/Injected.kt",
    "apps/android/android/gradle/verification-metadata.xml",
    "scripts/test/live-turn/go.mod",
    "scripts/test/live-turn/go.sum",
    "go.work",
    "scripts/test/live-turn/go.work",
    "scripts/test/live-turn/go.work.sum",
    "scripts/test/live-turn/third_party/x-crypto/go.mod",
    "Cargo.toml",
    "Cargo.lock",
    "crates/example/Cargo.toml",
    "crates/example/build.rs",
    "rust-toolchain.toml",
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "apps/example/package.json",
    "apps/example/.npmrc",
    "apps/example/.pnpmfile.cjs",
    "tools/pwa-tailscale-native-http/native-audit.mjs",
    "tools/pwa-tailscale-native-http/compose-native.mjs",
    "tools/pwa-tailscale-native-http/prepare-distribution.mjs",
    "tools/pwa-tailscale-native-http/new-helper.mjs",
    "scripts/security/gitleaks-reviewed-working-tree.json",
  ];
  const controller = new Map(policies.map((path) => [path, `blob:${path}`]));
  const api = new GitHub({ workflowSha: "a".repeat(40) });
  api.policyEntries = async () => policyEntriesForTree(controller);
  const expectedHash = await api.policyHash();
  for (const path of policies) {
    for (const value of [null, "changed"]) {
      const candidate = new Map(controller);
      if (value === null) candidate.delete(path);
      else candidate.set(path, value);
      api.tree = async () => candidate;
      assert.equal(await api.compatiblePolicy("b".repeat(40)), false, path);
    }
  }
  api.tree = async () => new Map(controller);
  assert.equal(await api.compatiblePolicy("b".repeat(40)), true);
  controller.set(".semgrepignore", "new-controller-policy");
  assert.notEqual(await api.policyHash(), expectedHash);
  for (const path of policies) {
    const without = new Map(controller);
    without.delete(path);
    api.policyEntries = async () => policyEntriesForTree(without);
    api.tree = async () => controller;
    assert.equal(await api.compatiblePolicy("b".repeat(40)), false, path);
  }
  api.tree = async () => new Map([...controller, ["docs/unrelated.md", "new"]]);
  api.policyEntries = async () => policyEntriesForTree(controller);
  assert.equal(await api.compatiblePolicy("b".repeat(40)), true);
});

test("missing required controller scanner configuration fails closed", async () => {
  const api = new GitHub({ workflowSha: "a".repeat(40) });
  const required = [
    "tools/pwa-tailscale-native-http/source.json",
    "packages/app-core/scripts/sops-oracle/oracle.mjs",
    "apps/android/scripts/build-core.sh",
    "crates/authenticator-core/src/bin/uniffi-bindgen.rs",
    "crates/authenticator-core/src/lib.rs",
    "apps/android/android/settings.gradle.kts",
    "apps/android/android/build.gradle.kts",
    "apps/android/android/app/build.gradle.kts",
    "apps/android/android/gradle.properties",
    "scripts/test/live-turn/go.mod",
    "scripts/test/live-turn/go.sum",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "package-lock.json",
    "pnpm-workspace.yaml",
    ".github/codeql/codeql-config.yml",
    ".gitleaks.toml",
    ".cargo/audit.toml",
    "deny.toml",
    "osv-scanner.toml",
    "scripts/lib/dependency-compatibility.test.mjs",
    "scripts/fuzz/jazzer-gate.sh",
    "scripts/lib/fuzz-directory.sh",
  ];
  const controller = new Map(
    [...CI_RECIPE, ...required].map((path) => [path, "blob"]),
  );
  api.tree = async () => controller;
  assert.ok((await api.policyEntries()).length >= 12);
  for (const path of required) {
    const incomplete = new Map(controller);
    incomplete.delete(path);
    api.tree = async () => incomplete;
    await assert.rejects(
      api.policyEntries(),
      /Current policy is incomplete/,
      path,
    );
  }
});

test("policy compatibility includes Git file modes and rejects policy symlinks", async () => {
  const path = ".gitleaks.toml";
  const sha = "a".repeat(40);
  const response = (mode) => ({
    ok: true,
    json: async () => ({
      truncated: false,
      tree: [{ path, sha, mode, type: "blob" }],
    }),
  });
  let mode = "100644";
  const api = new GitHub({ repository: POLICY.repository }, async () =>
    response(mode),
  );
  const original = await api.tree("a".repeat(40));
  api.policyEntries = async () => policyEntriesForTree(original);
  mode = "100755";
  assert.equal(await api.compatiblePolicy("b".repeat(40)), false);
  mode = "120000";
  await assert.rejects(api.tree("c".repeat(40)), /Invalid policy file mode/);
});

test("unrelated skill-package metadata is not executable extraction policy", () => {
  const path = ".claude/skills/scandinavian-design/scripts/package.json";
  assert.deepEqual(policyEntriesForTree(new Map([[path, "120000:blob"]])), []);
  assert.deepEqual(
    policyEntriesForTree(
      new Map([["apps/example/package.json", "100644:blob"]]),
    ),
    [["apps/example/package.json", "100644:blob"]],
  );
});
