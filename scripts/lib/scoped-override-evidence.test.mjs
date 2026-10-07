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
import {
  inspectScopedFindings,
  validateScopedOverrideFinding,
} from "./scoped-override-evidence.mjs";

const parentName = "@fixture/parent";
const childName = "@fixture/child";
const key = `${parentName}>${childName}`;
const overrides = { [key]: "2.4.0" };

function finding(ruleId = "OA006", scope = key) {
  return {
    ruleId,
    package: { name: childName },
    location: {
      file: "package.json",
      jsonPath: `/pnpm/overrides/${scope.replaceAll("~", "~0").replaceAll("/", "~1")}`,
    },
  };
}

function metadata(path, data) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify(data));
}

function parentFixture(root, version, childVersion = "2.4.0") {
  const modules = join(
    root,
    "node_modules/.pnpm",
    `parent@${version}`,
    "node_modules",
  );
  const parent = join(modules, parentName);
  const child = join(
    root,
    "node_modules/.pnpm",
    `child@${childVersion}`,
    "node_modules",
    childName,
  );
  metadata(parent, {
    name: parentName,
    version,
    dependencies: { [childName]: "~2.0.0" },
  });
  metadata(child, { name: childName, version: childVersion });
  mkdirSync(join(modules, "@fixture"), { recursive: true });
  symlinkSync(child, join(modules, childName), "dir");
  return { parent, child, link: join(modules, childName) };
}

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "scoped-override-"));
  try {
    metadata(root, { pnpm: { overrides } });
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("all physical scoped parents satisfy floors despite unrelated older global children", () =>
  fixture((root) => {
    parentFixture(root, "1.0.0");
    parentFixture(root, "1.1.0", "2.5.0");
    metadata(join(root, "node_modules", childName), {
      name: childName,
      version: "1.0.0",
    });
    for (const rule of ["OA006", "OA008"]) {
      const result = validateScopedOverrideFinding(
        root,
        overrides,
        finding(rule),
      );
      assert.equal(result.qualified, true);
      assert.equal(result.resolutions.length, 2);
      assert.deepEqual(
        result.resolutions.map((row) => row.childVersion).sort(),
        ["2.4.0", "2.5.0"],
      );
    }
  }));

test("one below-floor physical parent blocks the entire scope", () =>
  fixture((root) => {
    parentFixture(root, "1.0.0");
    parentFixture(root, "1.1.0", "2.3.9");
    assert.equal(
      validateScopedOverrideFinding(root, overrides, finding()).qualified,
      false,
    );
  }));

test("absent parents and unresolved children fail closed", () =>
  fixture((root) => {
    assert.equal(
      validateScopedOverrideFinding(root, overrides, finding()).qualified,
      false,
    );
    const paths = parentFixture(root, "1.0.0");
    rmSync(paths.link);
    assert.equal(
      validateScopedOverrideFinding(root, overrides, finding()).qualified,
      false,
    );
  }));

test("hoisted flat installation resolves its declared child", () =>
  fixture((root) => {
    metadata(join(root, "node_modules", parentName), {
      name: parentName,
      version: "1.0.0",
      dependencies: { [childName]: "^2.0.0" },
    });
    metadata(join(root, "node_modules", childName), {
      name: childName,
      version: "2.4.0",
    });
    assert.equal(
      validateScopedOverrideFinding(root, overrides, finding()).qualified,
      true,
    );
  }));

test("nested npm parent below floor blocks a valid root parent", () =>
  fixture((root) => {
    const rootParent = join(root, "node_modules", parentName);
    const nestedParent = join(
      root,
      "node_modules/outer/node_modules",
      parentName,
    );
    for (const path of [rootParent, nestedParent]) {
      metadata(path, {
        name: parentName,
        version: "1.0.0",
        dependencies: { [childName]: "^2.0.0" },
      });
    }
    metadata(join(root, "node_modules", childName), {
      name: childName,
      version: "2.4.0",
    });
    metadata(join(nestedParent, "node_modules", childName), {
      name: childName,
      version: "2.3.9",
    });
    assert.equal(
      validateScopedOverrideFinding(root, overrides, finding()).qualified,
      false,
    );
    metadata(join(nestedParent, "node_modules", childName), {
      name: childName,
      version: "2.4.0",
    });
    const result = validateScopedOverrideFinding(root, overrides, finding());
    assert.equal(result.qualified, true);
    assert.equal(result.resolutions.length, 2);
  }));

test("undeclared and ambiguous child dependencies fail closed", () =>
  fixture((root) => {
    const paths = parentFixture(root, "1.0.0");
    metadata(paths.parent, { name: parentName, version: "1.0.0" });
    assert.equal(
      validateScopedOverrideFinding(root, overrides, finding()).qualified,
      false,
    );
    metadata(paths.parent, {
      name: parentName,
      version: "1.0.0",
      dependencies: { [childName]: "2.4.0" },
      optionalDependencies: { [childName]: "2.4.0" },
    });
    assert.equal(
      validateScopedOverrideFinding(root, overrides, finding()).qualified,
      false,
    );
  }));

test("wrong child or parent metadata identities fail closed", () =>
  fixture((root) => {
    const paths = parentFixture(root, "1.0.0");
    metadata(paths.child, { name: "different", version: "2.4.0" });
    assert.equal(
      validateScopedOverrideFinding(root, overrides, finding()).qualified,
      false,
    );
    metadata(paths.child, { name: childName, version: "2.4.0" });
    metadata(paths.parent, {
      name: "different",
      version: "1.0.0",
      dependencies: { [childName]: "2.4.0" },
    });
    assert.equal(
      validateScopedOverrideFinding(root, overrides, finding()).qualified,
      false,
    );
  }));

test("ranges, prereleases and malformed scoped selectors are not qualified", () =>
  fixture((root) => {
    parentFixture(root, "1.0.0");
    for (const version of [
      "^2.4.0",
      ">=2.4.0",
      "2.4.0-beta.1",
      "02.4.0",
      "9007199254740992.0.0",
    ]) {
      assert.equal(
        validateScopedOverrideFinding(root, { [key]: version }, finding())
          .qualified,
        false,
      );
    }
    for (const scope of [
      `${key}>extra`,
      `${parentName}@1>${childName}`,
      childName,
    ]) {
      assert.equal(
        validateScopedOverrideFinding(
          root,
          { [scope]: "2.4.0" },
          finding("OA006", scope),
        ).qualified,
        false,
      );
    }
  }));

test("mismatched finding metadata, malformed pointers and other rules stay blocking", () =>
  fixture((root) => {
    parentFixture(root, "1.0.0");
    const original = finding();
    const controls = [
      { ...original, ruleId: "OA001" },
      { ...original, package: { name: "unrelated" } },
      {
        ...original,
        location: { ...original.location, file: "other/package.json" },
      },
      {
        ...original,
        location: {
          ...original.location,
          jsonPath: "/pnpm/overrides/bad~2key",
        },
      },
      {
        ...original,
        location: { ...original.location, jsonPath: "/dependencies/child" },
      },
    ];
    for (const control of controls) {
      assert.equal(
        validateScopedOverrideFinding(root, overrides, control).qualified,
        false,
      );
    }
    const results = inspectScopedFindings(root, [
      original,
      ...controls,
      finding("OA008", childName),
    ]);
    assert.deepEqual(
      results.filter((row) => row.qualified).map((row) => row.index),
      [0],
    );
  }));

test("package directories and package.json symlinks cannot escape the project", () =>
  fixture((root) => {
    const outside = mkdtempSync(join(tmpdir(), "scoped-outside-"));
    try {
      const paths = parentFixture(root, "1.0.0");
      metadata(outside, { name: childName, version: "2.4.0" });
      rmSync(paths.link);
      symlinkSync(outside, paths.link, "dir");
      assert.equal(
        validateScopedOverrideFinding(root, overrides, finding()).qualified,
        false,
      );
      rmSync(paths.link);
      symlinkSync(paths.child, paths.link, "dir");
      rmSync(join(paths.child, "package.json"));
      symlinkSync(
        join(outside, "package.json"),
        join(paths.child, "package.json"),
        "file",
      );
      assert.equal(
        validateScopedOverrideFinding(root, overrides, finding()).qualified,
        false,
      );
      metadata(paths.parent, {
        name: parentName,
        version: "1.0.0",
        dependencies: { [childName]: "2.4.0" },
      });
      rmSync(join(paths.parent, "package.json"));
      symlinkSync(
        join(outside, "package.json"),
        join(paths.parent, "package.json"),
        "file",
      );
      assert.equal(
        validateScopedOverrideFinding(root, overrides, finding()).qualified,
        false,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));
