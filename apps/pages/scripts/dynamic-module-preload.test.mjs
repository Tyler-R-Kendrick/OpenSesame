/** Keep the native ESM graph and CSS readiness while omitting repeated JS hints. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { build } from "vite";
import { test } from "vitest";
function find(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (node) => find(node, predicate));
}
function policy() {
  const config = ts.createSourceFile(
    "vite.config.ts",
    readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const property = find(
    config,
    (node) =>
      ts.isPropertyAssignment(node) &&
      node.name.getText(config) === "modulePreload",
  );
  assert.ok(property);
  return runInNewContext(`(${property.initializer.getText(config)})`);
}
function chunks(output) {
  return output.filter((item) => item.type === "chunk");
}
function moduleGraph(output) {
  const all = chunks(output);
  const identity = (name) => {
    const chunk = all.find((item) => item.fileName === name);
    assert.ok(chunk);
    return Object.keys(chunk.modules).sort().join("\n");
  };
  return all
    .map((chunk) => ({
      modules: Object.keys(chunk.modules).sort(),
      imports: chunk.imports.map(identity).sort(),
      dynamicImports: chunk.dynamicImports.map(identity).sort(),
    }))
    .sort((left, right) =>
      left.modules.join().localeCompare(right.modules.join()),
    );
}
function stylesAndImages(output) {
  return output
    .filter(
      (item) => item.type === "asset" && /\.(css|svg)$/.test(item.fileName),
    )
    .map((item) => ({ name: item.fileName, source: String(item.source) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
function initialHints(output) {
  const html = output.find(
    (item) => item.type === "asset" && item.fileName === "index.html",
  );
  assert.ok(html);
  return [
    ...String(html.source).matchAll(/<link rel="modulepreload"[^>]*>/g),
  ].map(([tag]) => tag);
}
function actualPreload(output) {
  const entry = chunks(output).find((chunk) => chunk.isEntry);
  assert.ok(entry);
  const source = ts.createSourceFile(
    "entry.js",
    entry.code,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set(["scriptRel", "assetsURL", "seen", "__vitePreload"]);
  const declarations = source.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (node) => ts.isIdentifier(node.name) && names.has(node.name.text),
      ),
  );
  assert.equal(declarations.length, 4);
  const links = [];
  const events = [];
  const context = {
    Promise,
    Event,
    document: {
      getElementsByTagName: () => links,
      querySelector: () => null,
      createElement() {
        const listeners = new Map();
        return {
          listeners,
          addEventListener: (name, listener) => listeners.set(name, listener),
        };
      },
      head: { appendChild: (link) => links.push(link) },
    },
    window: { dispatchEvent: (event) => events.push(event) },
  };
  runInNewContext(
    `${declarations.map((node) => node.getText(source)).join("\n")}\nglobalThis.invoke = __vitePreload;`,
    context,
  );
  return { invoke: context.invoke, links, events };
}
async function cssReadiness(output) {
  const { invoke, links, events } = actualPreload(output);
  let imported = 0;
  const load = invoke(async () => {
    imported++;
    return 8;
  }, ["assets/lazy.css"]);
  await Promise.resolve();
  assert.equal(
    imported,
    0,
    "CSS readiness still precedes the native module import",
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].rel, "stylesheet");
  links[0].listeners.get("load")();
  assert.equal(await load, 8);
  assert.equal(imported, 1);
  assert.equal(await invoke(async () => 9, ["assets/lazy.css"]), 9);
  assert.equal(links.length, 1, "loaded CSS remains deduplicated");
  const failed = invoke(async () => {
    imported++;
  }, ["assets/failed.css"]);
  links[1].listeners.get("error")();
  await assert.rejects(failed, /Unable to preload CSS/);
  assert.equal(imported, 1, "a failed stylesheet cannot import the component");
  assert.equal(events.at(-1).type, "vite:preloadError");
}
test("dynamic JS hints preserve the real Vite ESM graph, entry preloads, assets and awaited CSS", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "opensesame-preload-"));
  try {
    for (const [name, source] of Object.entries({
      "index.html": '<script type="module" src="/main.js"></script>',
      "main.js":
        'import { initial } from "./initial.js"; globalThis.initial = initial; globalThis.loadProof = () => import("./lazy.js"); globalThis.peer = new URL("./peer.svg", import.meta.url).href;',
      "initial.js":
        'import { shared } from "./shared.js"; export const initial = shared;',
      "shared.js": "export const shared = 7;",
      "lazy.js":
        'import "./lazy.css"; import { shared } from "./shared.js"; export const value = shared + 1;',
      "lazy.css": ".proof { color: green; }",
      "peer.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    }))
      writeFileSync(join(fixture, name), source, { flag: "wx" });
    const options = {
      configFile: false,
      root: fixture,
      base: "/OpenSesame/",
      publicDir: false,
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        cssMinify: false,
        assetsInlineLimit: 0,
        target: "es2022",
        rollupOptions: {
          output: {
            manualChunks(id) {
              if (id.endsWith("/shared.js")) return "shared";
              if (id.endsWith("/initial.js")) return "initial";
            },
          },
        },
      },
    };
    const before = (await build(options)).output;
    const after = (
      await build({
        ...options,
        build: { ...options.build, modulePreload: policy() },
      })
    ).output;
    assert.deepEqual(moduleGraph(after), moduleGraph(before));
    assert.deepEqual(stylesAndImages(after), stylesAndImages(before));
    assert.ok(initialHints(before).length > 0);
    assert.deepEqual(initialHints(after), initialHints(before));
    const entry = chunks(after).find((chunk) => chunk.isEntry);
    assert.ok(entry);
    const css = after.find(
      (asset) => asset.type === "asset" && asset.fileName.endsWith(".css"),
    );
    assert.ok(css);
    assert.ok(entry.code.includes(css.fileName));
    const table = /m\.f=\[(.*?)\]/.exec(entry.code);
    assert.ok(table);
    assert.deepEqual(JSON.parse(`[${table[1]}]`), [css.fileName]);
    const originalEntry = chunks(before).find((chunk) => chunk.isEntry);
    assert.ok(originalEntry);
    const oldTable = /m\.f=\[(.*?)\]/.exec(originalEntry.code);
    assert.ok(oldTable);
    assert.ok(
      JSON.parse(`[${oldTable[1]}]`).some((name) => name.endsWith(".js")),
    );
    await cssReadiness(after);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
