import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { validateScopedOverrideFinding } from "./scoped-override-evidence.mjs";
function metadata(path, data) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify(data));
}
function finding(ruleId, scope) {
  return {
    ruleId,
    location: {
      file: "package.json",
      jsonPath: `/pnpm/overrides/${scope.replaceAll("~", "~0").replaceAll("/", "~1")}`,
    },
  };
}
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "scoped-selector-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function yamlFixture(root, version, argparse = "2.0.1") {
  const modules = join(
    root,
    "node_modules/.pnpm",
    `js-yaml@${version}`,
    "node_modules",
  );
  const parent = join(modules, "js-yaml");
  metadata(parent, {
    name: "js-yaml",
    version,
    dependencies: { argparse: "1.0.10" },
  });
  metadata(join(modules, "argparse"), { name: "argparse", version: argparse });
  return parent;
}

function yamlFinding(scope, packageName = "js-yaml") {
  return { ...finding("OA006", scope), package: { name: packageName } };
}

test("major selector inspects only matching installed versions and never an empty selection", () =>
  fixture((root) => {
    const scope = "js-yaml@^3";
    const map = { [scope]: "3.15.2" };
    yamlFixture(root, "5.4.3");
    assert.equal(
      validateScopedOverrideFinding(root, map, yamlFinding(scope)).qualified,
      false,
    );
    yamlFixture(root, "3.15.2");
    const result = validateScopedOverrideFinding(root, map, yamlFinding(scope));
    assert.equal(result.qualified, true);
    assert.deepEqual(
      result.resolutions.map((r) => r.parentVersion),
      ["3.15.2"],
    );
    yamlFixture(root, "3.15.1");
    assert.equal(
      validateScopedOverrideFinding(root, map, yamlFinding(scope)).qualified,
      false,
    );
  }));

test("exact parent selector checks every selected child edge and ignores other versions", () =>
  fixture((root) => {
    const scope = "js-yaml@3.15.2>argparse";
    const map = { [scope]: "2.0.1" };
    yamlFixture(root, "5.4.3", "1.0.0");
    assert.equal(
      validateScopedOverrideFinding(root, map, yamlFinding(scope, "argparse"))
        .qualified,
      false,
    );
    const selected = yamlFixture(root, "3.15.2");
    assert.equal(
      validateScopedOverrideFinding(root, map, yamlFinding(scope, "argparse"))
        .qualified,
      true,
    );
    metadata(join(selected, "../argparse"), {
      name: "argparse",
      version: "2.0.0",
    });
    assert.equal(
      validateScopedOverrideFinding(root, map, yamlFinding(scope, "argparse"))
        .qualified,
      false,
    );
  }));

test("incorrect scanner attribution requires its exact known shape and verified reported parent", () =>
  fixture((root) => {
    const scope = "js-yaml@3.15.2>argparse";
    const map = { [scope]: "2.0.1" };
    yamlFixture(root, "3.15.2");
    const report = {
      ...yamlFinding(scope),
      severity: "medium",
      message:
        "Override fights an exact-pinned parent (effect not confirmed on disk)",
      details:
        'js-yaml is overridden to "2.0.1", but its installed parent promptfoo@0.122.0 declares it as exact (dependencies: "5.2.2"). No installed copy confirms the override took; if the parent\'s exact pin wins resolution, npm/pnpm keep that version on disk and the override does nothing. Override the parent instead.',
    };
    assert.equal(
      validateScopedOverrideFinding(root, map, report).qualified,
      false,
    );
    metadata(join(root, "node_modules/promptfoo"), {
      name: "promptfoo",
      version: "0.122.0",
      dependencies: { "js-yaml": "5.2.2" },
    });
    assert.equal(
      validateScopedOverrideFinding(root, map, report).qualified,
      true,
    );
    for (const changed of [
      { ...report, ruleId: "OA008" },
      { ...report, details: "arbitrary mismatch" },
      { ...report, package: { name: "other" } },
    ]) {
      assert.equal(
        validateScopedOverrideFinding(root, map, changed).qualified,
        false,
      );
    }
  }));

test("selector bounds, dangling selected child and escaping edges remain fail closed", () =>
  fixture((root) => {
    const parent = yamlFixture(root, "3.15.2");
    for (const scope of [
      "js-yaml@^5",
      "js-yaml@>=3",
      "js-yaml@3>argparse",
      "js-yaml@3.15.2>argparse>other",
    ]) {
      assert.equal(
        validateScopedOverrideFinding(
          root,
          { [scope]: "2.0.1" },
          yamlFinding(scope),
        ).qualified,
        false,
      );
    }
    const scope = "js-yaml@3.15.2>argparse";
    const child = join(parent, "../argparse");
    rmSync(child, { recursive: true });
    symlinkSync(join(root, "missing"), child, "dir");
    assert.equal(
      validateScopedOverrideFinding(
        root,
        { [scope]: "2.0.1" },
        yamlFinding(scope, "argparse"),
      ).qualified,
      false,
    );
    rmSync(child);
    const outside = mkdtempSync(join(tmpdir(), "yaml-outside-"));
    try {
      metadata(outside, { name: "argparse", version: "2.0.1" });
      symlinkSync(outside, child, "dir");
      assert.equal(
        validateScopedOverrideFinding(
          root,
          { [scope]: "2.0.1" },
          yamlFinding(scope, "argparse"),
        ).qualified,
        false,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));
