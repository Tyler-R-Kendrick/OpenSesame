import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// ADR 0139 / ADR 0150 §7: the companion handles exactly the messages the
// capability registry maps onto the extension surface for the
// `browser-autofill` plugin — no handler without a registry row, no row
// naming a message nothing here handles.
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
    .filter(
      (c) =>
        c.plugin === "browser-autofill" &&
        c.surfaces.extension?.startsWith("message:") === true,
    )
    .map((c) => [c.surfaces.extension.replace(/^message:/, ""), c.id]),
);

test("the registry maps the plugin's messages", () => {
  assert.ok(mapped.size > 0, "no browser-autofill rows in the registry");
});

test("every handled message is a browser-autofill registry capability", () => {
  for (const type of handled) {
    assert.ok(
      mapped.has(type),
      `background.ts handles "${type}" but no browser-autofill capability maps it`,
    );
  }
});

test("every browser-autofill extension surface is handled", () => {
  for (const [type, id] of mapped) {
    assert.ok(
      handled.has(type),
      `${id} maps extension: "message:${type}" but background.ts does not handle it`,
    );
  }
});

test("the protocol's message names are the registry's", () => {
  const protocol = readFileSync(join(ext, "lib/fill/protocol.ts"), "utf8");
  for (const type of mapped.keys()) {
    assert.ok(protocol.includes(`"${type}"`), `protocol.ts lacks "${type}"`);
  }
});

test("no row the plugin carries reaches an agent surface", () => {
  for (const row of registry.filter((c) => c.plugin === "browser-autofill")) {
    for (const surface of ["mcp_host", "mcp_client", "webmcp"]) {
      assert.equal(row.surfaces[surface], null, `${row.id} maps ${surface}`);
      assert.ok(row.excluded?.[surface], `${row.id} must exclude ${surface}`);
    }
  }
});
