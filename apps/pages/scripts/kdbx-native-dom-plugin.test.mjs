import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it as test } from "vitest";
import { classify } from "../src/lib/capabilities/classification.js";
import { kdbxNativeDOM } from "./kdbx-native-dom-plugin.mjs";

const root =
  process.env.PAGES_KDBX_TEST_ROOT ??
  fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(resolve(root, "packages/app-core/package.json"));
const sdk = realpathSync(require.resolve("kdbxweb"));

test("only replaces the reviewed SDK's exact XML fallback during builds", () => {
  assert.equal(classify("src/lib/kdbx-native-dom.ts"), null);
  assert.equal(
    classify("src/browser/kdbx-native-dom.ts")?.classification,
    "core",
  );
  const plugin = kdbxNativeDOM(root);
  assert.equal(plugin.apply, "build");
  plugin.buildStart();
  assert.equal(
    plugin.resolveId("@xmldom/xmldom", sdk),
    fileURLToPath(
      new URL(
        "../../../packages/app-core/src/browser/kdbx-native-dom.ts",
        import.meta.url,
      ),
    ),
  );
  for (const importer of [
    undefined,
    `${sdk}?other`,
    `${sdk}/other`,
    sdk.replace("kdbxweb", "other"),
    resolve(root, "packages/app-core/src/browser/saml/xml-policy.ts"),
  ]) {
    assert.equal(plugin.resolveId("@xmldom/xmldom", importer), null);
  }
  for (const source of [
    "@xmldom/xmldom/lib/dom.js",
    "xmldom",
    "crypto",
    "kdbxweb",
  ])
    assert.equal(plugin.resolveId(source, sdk), null);
});

test("ordinary Node SDK resolution and XML integrity remain unchanged", async () => {
  const xml = createRequire(sdk)("@xmldom/xmldom");
  assert.equal(
    new xml.DOMParser().parseFromString("<Root/>", "application/xml")
      .documentElement.tagName,
    "Root",
  );
  const codec = require("kdbxweb");
  assert.throws(() => codec.XmlUtils.parse("<Root><missing></Root>"));
  const doc = codec.XmlUtils.parse("<Root><V>retained</V></Root>");
  assert.equal(doc.getElementsByTagName("V")[0].textContent, "retained");
});

test("a replacement SDK cannot acquire the pinned fallback adapter", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "kdbx-unreviewed-"));
  try {
    const packageRoot = resolve(
      directory,
      "packages/app-core/node_modules/kdbxweb",
    );
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(resolve(packageRoot, "package.json"), '{"main":"index.js"}');
    const changed = resolve(packageRoot, "index.js");
    writeFileSync(changed, "module.exports = {};");
    const plugin = kdbxNativeDOM(directory);
    assert.throws(() => plugin.buildStart(), /reviewed SDK bytes/);
    assert.throws(
      () => plugin.resolveId("@xmldom/xmldom", changed),
      /reviewed SDK bytes/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
