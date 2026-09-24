import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// ADR 0139: the extension handles exactly the messages the capability
// registry maps onto its surface — no handler without a registry row, no
// row naming a message nothing handles.
const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, "..");
const registry = JSON.parse(
  readFileSync(
    join(ext, "../../packages/capability-registry/capabilities.json"),
    "utf8",
  ),
);

const background = readFileSync(join(ext, "entrypoints/background.ts"), "utf8");
const handled = new Set(
  [...background.matchAll(/message\?\.type === "([^"]+)"/g)].map((m) => m[1]),
);

const mapped = new Map(
  registry
    .filter((c) => typeof c.surfaces.extension === "string")
    .map((c) => [c.surfaces.extension.replace(/^message:/, ""), c.id]),
);

test("the background handles at least one message", () => {
  assert.ok(handled.size > 0, "no message handlers found in background.ts");
});

test("every handled message is a registry capability", () => {
  for (const type of handled) {
    assert.ok(
      mapped.has(type),
      `background.ts handles "${type}" but no capability maps extension: "message:${type}"`,
    );
  }
});

test("every registry extension surface is handled", () => {
  for (const [type, id] of mapped) {
    assert.ok(
      handled.has(type),
      `${id} maps extension: "message:${type}" but background.ts does not handle it`,
    );
  }
});

test("every message the popup sends is handled", () => {
  const popup = readFileSync(join(ext, "entrypoints/popup/main.ts"), "utf8");
  for (const [, type] of popup.matchAll(/type: "(opensesame\.[^"]+)"/g)) {
    assert.ok(
      handled.has(type),
      `popup sends "${type}" but nothing handles it`,
    );
  }
});
