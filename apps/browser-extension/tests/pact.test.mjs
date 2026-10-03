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

test("the Host base is only trusted if it is still a loopback origin", () => {
  const src = readFileSync(join(ext, "runner/host-base.ts"), "utf8");
  assertSourceOrder(src, [
    "normalizeLoopbackBaseUrl",
    "if (normalized) return normalized",
    "DEFAULT_HOST",
  ]);
});

test("background asks for the Host base only through that one place", () => {
  const src = readFileSync(join(ext, "entrypoints/background.ts"), "utf8");
  assert.ok(src.includes('from "../runner/host-base"'));
  assert.equal(src.includes("normalizeLoopbackBaseUrl"), false);
  assert.equal(/getSecret\s*\(/.test(src), false);
  assert.ok(src.includes("Never exposes getSecret"));
});

test("popup refuses a remote rewrite before persisting", () => {
  const src = readFileSync(join(ext, "entrypoints/popup/main.ts"), "utf8");
  assertSourceOrder(src, [
    "normalizeLoopbackBaseUrl(raw)",
    "if (!value)",
    'sealForRest(STORE, "hostApiBase", value)',
    "browser.storage.local.set({ hostApiBase: sealed })",
  ]);
});

test("hostApiBase is never stored in the clear (ADR 0149)", () => {
  for (const file of ["entrypoints/popup/main.ts", "runner/host-base.ts"]) {
    const src = readFileSync(join(ext, file), "utf8");
    const writes = [
      ...src.matchAll(/browser\.storage\.local\.set\(\{([^}]*)\}/g),
    ];
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
    src.includes("browser.storage.local.set({ hostApiBase: raw })"),
    false,
  );
});
