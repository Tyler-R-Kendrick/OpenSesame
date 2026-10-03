import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The local runner's structural pacts (ADR 0076, 0079, 0082, 0149, 0159): what
// the source may not contain and the order its decisions must be made in. The
// behavioural pacts — a fake Host, a full recipe walk, the negative cases —
// are the vitest suites beside the code in runner/.
const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..");
const read = (...parts) => readFileSync(join(ext, ...parts), "utf8");

/** Source without its comments, so prose about a thing is not the thing. */
const code = (source) =>
  source.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");

function assertSourceOrder(src, ordered) {
  let last = 0;
  for (const marker of ordered) {
    const pos = src.indexOf(marker, last);
    assert.notEqual(pos, -1, `missing ${marker}`);
    last = pos;
  }
}

const walk = (dir) =>
  readdirSync(join(ext, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith(".ts") && !/\.test\.ts$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
const runtime = [...walk("runner"), ...walk("entrypoints")].filter(
  (file) => !file.includes("test-support"),
);

test("nothing the runner keeps rests in the clear (ADR 0149)", () => {
  for (const file of runtime) {
    const source = code(read(file));
    assert.doesNotMatch(
      source,
      /localStorage|sessionStorage|indexedDB|document\.cookie/,
      `${file} writes a browser global`,
    );
  }
  // The runner's only door to storage is the sealed store, and that door
  // writes nothing it did not seal first.
  const store = code(read("runner/store.ts"));
  assertSourceOrder(store, [
    "const sealed = await this.sealer.seal(STORE, key, text)",
    "if (sealed === null) throw new AtRestUnavailable()",
    "await this.raw.set(key, sealed)",
  ]);
  assert.equal((store.match(/this\.raw\.set\(/g) ?? []).length, 1);
  // (`host-base.ts` and the popup write the one Host-base setting, which
  // `pact.test.mjs` pins to a sealed value.)
  const doors = [
    join("runner", "store.ts"),
    join("runner", "host-base.ts"),
    join("entrypoints", "popup", "main.ts"),
  ];
  for (const file of runtime) {
    if (doors.includes(file)) continue;
    assert.doesNotMatch(
      code(read(file)),
      /storage\.local\.(set|remove)\(\{?[^)]*\)/,
      `${file} writes storage past the sealed store`,
    );
  }
});

test("a value is never logged, and nothing offers to read one out", () => {
  for (const file of runtime) {
    const source = code(read(file));
    assert.doesNotMatch(source, /console\./, `${file} logs`);
    assert.doesNotMatch(source, /getSecret\s*\(/, `${file} offers getSecret`);
  }
});

test("no outcome constructor takes a value to carry", () => {
  const wire = code(read("runner/wire.ts"));
  const signatures = [...wire.matchAll(/export const (\w+) = \(([^)]*)\)/g)];
  assert.ok(signatures.length >= 8, "found the constructors");
  for (const [, name, params] of signatures) {
    assert.doesNotMatch(
      params,
      /password|secret|credential|plaintext|token|\bvalue\b/i,
      `${name}(${params}) takes a value`,
    );
  }
  // The Host's outcomes, spelled exactly: the Host refuses any other member.
  for (const member of [
    'outcome: "done"',
    'outcome: "filled"',
    'outcome: "presence"',
    'outcome: "verified"',
    'outcome: "dom"',
    'outcome: "frame"',
    'outcome: "sealed"',
    'outcome: "failed"',
  ]) {
    assert.ok(wire.includes(member), `wire builds ${member}`);
  }
});

test("every answer passes the guard before it is returned", () => {
  const driver = code(read("runner/driver.ts"));
  assertSourceOrder(driver, [
    "export async function runStep(",
    "outcome = await execute(request, d)",
    'outcome = failed("transport")',
    "return guard(request.step, outcome, known)",
  ]);
});

test("a step is decoded, then run, then settled, and only after the run is re-read", () => {
  const drive = code(read("runner/drive.ts"));
  assertSourceOrder(drive, [
    "await link.host.getRun(run.id)",
    "await skipReason(env.deps, current, env.now())",
    "await link.host.claim(run.id)",
    "await answer(env, context, step, run)",
    "await settle(link.host, run.id, step, outcome)",
  ]);
  // The answer decodes before it runs, and runs before it is remembered.
  assertSourceOrder(drive, [
    "decodeRunnerStepRequest(step.request)",
    "await env.deps.settings.lastOutcome(run.id)",
    "await runStep(request, context)",
    "await env.deps.settings.keepOutcome(run.id, step.seq, outcome)",
  ]);
  // Readiness is decided in one place, before any claim.
  assertSourceOrder(code(read("runner/readiness.ts")), [
    'return "closed"',
    'return "human_holds_page"',
    'return "not_driving"',
    'return "origin_refused"',
    'return "not_armed"',
    'return "no_grant"',
    'return "no_credential"',
    'return "no_recovery_key"',
    'return "no_private_context"',
  ]);
});

test("the backup is acknowledged only after it was pushed and read back", () => {
  const backup = code(read("runner/backup.ts"));
  assertSourceOrder(backup, [
    "export async function backUp(",
    "await store.push(id, bytes)",
    "return await store.confirm(id, bytes)",
    "return false",
  ]);
  const vault = code(read("runner/vault.ts"));
  assertSourceOrder(vault, [
    "async seal(",
    "const recipient = await this.recipient()",
    "if (!recipient) return false",
    "await backUp(",
    'state: "sealed"',
  ]);
  // A candidate is promoted only once sealed (its backup proven).
  assertSourceOrder(vault, [
    "async promote(",
    'if (record.state === "generated") return false',
    "password: record.value",
  ]);
});

test("the runner only ever acts inside the run's origin", () => {
  const driver = code(read("runner/driver.ts"));
  assertSourceOrder(driver, [
    "withinOrigin(url, d.run.origin)",
    'return failed("navigation")',
    "d.pages.navigate(url)",
  ]);
  for (const file of ["runner/tab.ts", "runner/browser.ts"]) {
    const source = code(read(file));
    assert.doesNotMatch(source, /allFrames: true/, file);
    assert.doesNotMatch(source, /world: "MAIN"/, file);
  }
  // Every injection goes through the one function that checks the origin first.
  const tab = code(read("runner/tab.ts"));
  assertSourceOrder(tab, [
    "async function inject",
    'if (!(await onOrigin())) throw new Error("off_origin")',
    "browser.scripting.executeScript",
  ]);
  assert.match(tab, /frameIds: \[0\]/);
  assert.match(tab, /world: "ISOLATED"/);
  assert.equal((tab.match(/executeScript\(/g) ?? []).length, 1);
  assert.doesNotMatch(code(read("runner/browser.ts")), /executeScript/);
});

test("only this extension's own pages may arm, disarm or ask about the runner", () => {
  const background = code(read("entrypoints/background.ts"));
  for (const type of ["status", "arm", "disarm"]) {
    const at = background.indexOf(
      `message?.type === "opensesame.runner.${type}"`,
    );
    assert.notEqual(at, -1, `handles ${type}`);
    const branch = background.slice(at, at + 160);
    assert.match(branch, /if \(!fromOwnPage\(sender\)\) return undefined/);
  }
  assertSourceOrder(background, [
    "function fromOwnPage(",
    'isOwnPage(sender, browser.runtime.id, browser.runtime.getURL(""))',
  ]);
  assertSourceOrder(code(read("runner/sender.ts")), [
    "sender.id === ownId",
    "isString(sender.url)",
    "sender.url.startsWith(ownBase)",
  ]);
});

test("the manifest holds nothing for the runner until a person asks the browser", () => {
  const config = code(read("wxt.config.ts"));
  const flat = config.replace(/\s+/g, "");
  assert.match(flat, /[^_]permissions:\["storage","alarms"\]/);
  assert.match(
    flat,
    /[^_]host_permissions:\["http:\/\/127\.0\.0\.1\/\*","http:\/\/localhost\/\*"\]/,
  );
  assert.match(flat, /optional_permissions:\["scripting"\]/);
  assert.match(flat, /optional_host_permissions:\["https:\/\/\*\/\*"\]/);
  for (const absent of [
    /content_scripts/,
    /<all_urls>/,
    /activeTab/,
    /commands/,
    /"tabs"/,
    /webRequest/,
    /"debugger"/,
    /browsingData/,
    /cookies/,
  ]) {
    assert.doesNotMatch(config, absent);
  }
  // `scripting` appears once, and only as an optional permission.
  assert.equal((config.match(/scripting/g) ?? []).length, 1);
  for (const file of readdirSync(join(ext, "entrypoints"))) {
    if (!file.endsWith(".ts")) continue;
    assert.doesNotMatch(
      read("entrypoints", file),
      /defineContentScript/,
      `${file} would add a manifest content script`,
    );
  }
});

test("a built manifest, when present, declares no content script and no standing runner permission", () => {
  const built = join(ext, ".output/chrome-mv3/manifest.json");
  if (!existsSync(built)) return;
  const manifest = JSON.parse(readFileSync(built, "utf8"));
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.permissions, ["storage", "alarms"]);
  assert.deepEqual(manifest.optional_permissions, ["scripting"]);
  assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
  assert.deepEqual(manifest.host_permissions, [
    "http://127.0.0.1/*",
    "http://localhost/*",
  ]);
});

test("the options page asks the browser for one origin on the person's own click", () => {
  const options = code(read("entrypoints/options/main.ts"));
  assertSourceOrder(options, [
    'el("drive-arm").addEventListener("click"',
    "browser.permissions",
    '.request({ permissions: ["scripting"], origins: [matchPattern(origin)] })',
    "arm(origin)",
  ]);
});
