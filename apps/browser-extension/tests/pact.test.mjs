import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..");

function assertSourceOrder(src, ordered) {
  let last = 0;
  for (const marker of ordered) {
    const pos = src.indexOf(marker, last);
    assert.notEqual(pos, -1, `missing ${marker}`);
    last = pos;
  }
}

test("background only trusts a loopback hostApiBase", () => {
  const src = readFileSync(join(ext, "entrypoints/background.ts"), "utf8");
  assertSourceOrder(src, [
    "normalizeLoopbackBaseUrl",
    "if (normalized) return normalized",
    "DEFAULT_HOST",
  ]);
  assert.equal(/getSecret\s*\(/.test(src), false);
  assert.ok(src.includes("Never exposes getSecret"));
});

test("popup refuses a remote rewrite before persisting", () => {
  const src = readFileSync(join(ext, "entrypoints/popup/main.ts"), "utf8");
  assertSourceOrder(src, [
    "normalizeLoopbackBaseUrl(raw)",
    "if (!value)",
    'sealForRest("chrome.storage.local", "hostApiBase", value)',
    "chrome.storage.local.set({ hostApiBase: sealed })",
  ]);
});

test("hostApiBase is never stored in the clear (ADR 0148)", () => {
  for (const file of ["entrypoints/popup/main.ts", "entrypoints/background.ts"]) {
    const src = readFileSync(join(ext, file), "utf8");
    const writes = [...src.matchAll(/chrome\.storage\.local\.set\(\{([^}]*)\}/g)];
    assert.ok(writes.length > 0, `${file} writes hostApiBase somewhere`);
    for (const [, body] of writes) {
      assert.equal(body.trim(), "hostApiBase: sealed", `${file}: ${body}`);
    }
  }
});

test("chaos: health errors do not persist an unnormalized host", () => {
  const src = readFileSync(join(ext, "entrypoints/popup/main.ts"), "utf8");
  assertSourceOrder(src, [
    'type: "opensesame.health"',
    "Could not load status",
  ]);
  assert.equal(
    src.includes("chrome.storage.local.set({ hostApiBase: raw })"),
    false,
  );
});
