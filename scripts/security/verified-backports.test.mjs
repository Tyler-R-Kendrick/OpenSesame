import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertDependencyAbsent,
  dependencyPresent,
} from "./dependency-presence.mjs";
import { verifyBackportSource } from "./verified-backports.mjs";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const proof = ["braces", "3.0.3", "GHSA-vfj7-8cjw-p6xm"];
function fixture(run) {
  const root = mkdtempSync(resolve(tmpdir(), "backport-evidence-"));
  try {
    for (const file of ["package.json", "pnpm-lock.yaml"])
      cpSync(resolve(repository, file), resolve(root, file));
    cpSync(resolve(repository, "patches"), resolve(root, "patches"), {
      recursive: true,
    });
    const source = realpathSync(
      resolve(repository, "node_modules/.pnpm/node_modules/braces"),
    );
    const target = resolve(
      root,
      "node_modules/.pnpm",
      source.split("/.pnpm/")[1],
    );
    mkdirSync(resolve(root, "node_modules/.pnpm/node_modules"), {
      recursive: true,
    });
    cpSync(source, target, { recursive: true });
    symlinkSync(
      target,
      resolve(root, "node_modules/.pnpm/node_modules/braces"),
    );
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (dependencyPresent("braces")) {
  test("exact source evidence passes, unknown advisory or version never matches", () => {
    assert.equal(verifyBackportSource(...proof), true);
    assert.equal(verifyBackportSource("braces", "3.0.3", "unknown"), false);
    assert.equal(verifyBackportSource("braces", "3.0.2", proof[2]), false);
  });
  test("missing or altered patch fails closed", () =>
    fixture((root) => {
      const patch = resolve(root, "patches/braces@3.0.3.patch");
      writeFileSync(patch, "unproven repair");
      assert.throws(
        () => verifyBackportSource(...proof, root),
        /patch hash mismatch/,
      );
      rmSync(patch);
      assert.throws(() => verifyBackportSource(...proof, root));
    }));
  test("raw dependency edge fails closed", () =>
    fixture((root) => {
      const file = resolve(root, "pnpm-lock.yaml");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          /braces: 3\.0\.3\(patch_hash=[^)]+\)/g,
          "braces: 3.0.3",
        ),
      );
      assert.throws(
        () => verifyBackportSource(...proof, root),
        /Unpatched dependency edge/,
      );
    }));
  test("altered installed source fails closed", () =>
    fixture((root) => {
      writeFileSync(
        resolve(root, "node_modules/.pnpm/node_modules/braces/lib/parse.js"),
        "module.exports = () => {};\n",
      );
      assert.throws(
        () => verifyBackportSource(...proof, root),
        /source hash mismatch/,
      );
    }));

  test("raw direct importer and aliased snapshot dependencies fail closed", () => {
    for (const addition of [
      "    devDependencies:\n      braces:\n        specifier: 3.0.3\n        version: 3.0.3\n",
      "    dependencies:\n      alias: braces@3.0.3\n",
    ])
      fixture((root) => {
        const file = resolve(root, "pnpm-lock.yaml");
        const text = readFileSync(file, "utf8");
        const section = addition.includes("specifier")
          ? "importers"
          : "snapshots";
        writeFileSync(
          file,
          text.replace(
            `${section}:\n`,
            `${section}:\n  attack-fixture:\n${addition}`,
          ),
        );
        assert.throws(
          () => verifyBackportSource(...proof, root),
          /Unpatched.*dependency edge/,
        );
      });
  });
} else {
  test("unused braces backport is not declared and no raw or aliased dependency remains", () =>
    assertDependencyAbsent("braces"));
}
test("unknown advisory and versions never receive source remediation", () => {
  assert.equal(verifyBackportSource("braces", "3.0.3", "unknown"), false);
  assert.equal(verifyBackportSource("braces", "3.0.2", proof[2]), false);
});
