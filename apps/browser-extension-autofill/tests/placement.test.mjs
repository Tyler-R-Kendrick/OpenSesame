import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// ADR 0150 §6.4 and §7: where the autofill code lives, and what it may not
// declare. Each test is named for what it keeps out.
const here = dirname(fileURLToPath(import.meta.url));
const companion = join(here, "..");
const base = join(companion, "../browser-extension");
const read = (...parts) => readFileSync(join(...parts), "utf8");

const HOST_PERMISSIONS = /(^|[^_])host_permissions\s*:/m;

/** Source without its comments, so prose about a key is not the key. */
const code = (source) =>
  source.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");

test("the companion declares no content script and no standing host permission", () => {
  const config = code(read(companion, "wxt.config.ts"));
  assert.doesNotMatch(config, /content_scripts/);
  assert.doesNotMatch(config, HOST_PERMISSIONS);
  assert.match(config, /optional_host_permissions/);
  for (const file of readdirSync(join(companion, "entrypoints"))) {
    if (!file.endsWith(".ts")) continue;
    assert.doesNotMatch(
      read(companion, "entrypoints", file),
      /defineContentScript/,
      `${file} would add a manifest content script`,
    );
  }
});

test("a built manifest, when present, carries no content script or host permission", () => {
  const built = join(companion, ".output/chrome-mv3/manifest.json");
  if (!existsSync(built)) return;
  const manifest = JSON.parse(readFileSync(built, "utf8"));
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.ok(Array.isArray(manifest.optional_host_permissions));
});

test("the guard is registered at runtime, top frame only, per switched-on host", () => {
  const ports = read(companion, "lib/fill/browser-ports.ts");
  assert.match(ports, /registerContentScripts/);
  assert.match(ports, /allFrames: false/);
  assert.match(ports, /frameIds: \[0\]/);
  assert.doesNotMatch(ports, /allFrames: true/);
});

test("the guard draws nothing into the page and listens to nothing the page sends", () => {
  for (const file of ["guard-runtime.ts", "facts.ts", "guard.ts", "write.ts"]) {
    const source = read(companion, "lib/fill", file);
    for (const overlay of [
      /createElement/,
      /appendChild/,
      /attachShadow/,
      /innerHTML/,
      /insertAdjacent/,
      /addEventListener\(/,
      /DOMContentLoaded/,
    ]) {
      assert.doesNotMatch(source, overlay, `${file} uses ${overlay}`);
    }
  }
});

test("the guard does nothing on load but listen for this extension's arm", () => {
  const entry = read(companion, "entrypoints/fill-guard.ts");
  assert.match(entry, /defineUnlistedScript/);
  assert.match(entry, /claimDocument\(window\)/);
  assert.match(entry, /armMessage\.safeParse\(message\)/);
  const runtime = read(companion, "lib/fill/guard-runtime.ts");
  assert.match(entry, /fromThisExtension\(sender, browser\.runtime\.id\)/);
  assert.match(runtime, /sender\.id === ownId/);
});

test("a value is never logged or stored by the companion", () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
          ? [join(dir, entry.name)]
          : [],
    );
  for (const file of [
    ...walk(join(companion, "lib")),
    ...walk(join(companion, "entrypoints")),
  ]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /console\./, `${file} logs`);
    assert.doesNotMatch(source, /localStorage|indexedDB/, `${file} stores`);
  }
});

test("the default extension carries no fill code and no standing new permission", () => {
  // The default extension is also the local runner of a person's own run
  // steps (ADR 0076/0079/0082), which holds nothing until a person asks the
  // browser for one origin: `scripting` and `https://*/*` are optional only.
  // What it still carries none of is autofill: no fill guard, no fill code,
  // no daemon fill route, and nothing standing.
  assert.equal(existsSync(join(base, "lib")), false);
  assert.equal(existsSync(join(base, "entrypoints/fill-guard.ts")), false);
  const flat = code(read(base, "wxt.config.ts")).replace(/\s+/g, "");
  assert.match(flat, /[^_]permissions:\["storage","alarms"\]/);
  assert.match(flat, /optional_permissions:\["scripting"\]/);
  assert.match(flat, /optional_host_permissions:\["https:\/\/\*\/\*"\]/);
  for (const absent of [/activeTab/, /commands/, /content_scripts/]) {
    assert.doesNotMatch(flat, absent);
  }
  // `scripting` is never a standing permission.
  assert.equal((flat.match(/scripting/g) ?? []).length, 1);
  const background = read(base, "entrypoints/background.ts");
  assert.doesNotMatch(background, /opensesame\.fill|\/v1\/fill/);
  const pkg = JSON.parse(read(base, "package.json"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.equal(deps["@opensesame/browser-extension-autofill"], undefined);
});

test("popup policy permits only same-origin scripts and compiled WASM", () => {
  const html = read(companion, "entrypoints", "popup", "index.html");
  const policy = html.match(/content="([^"]*script-src[^"]*)"/)?.[1];
  assert.ok(policy);
  assert.equal(
    policy
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("script-src ")),
    "script-src 'self' 'wasm-unsafe-eval'",
  );
  assert.doesNotMatch(policy, /'unsafe-eval'/);
});
