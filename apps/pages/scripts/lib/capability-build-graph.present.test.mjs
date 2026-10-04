import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { buildGraph } from "../capability-compose-plugin.mjs";
import {
  compose,
  fakeBundle,
  makeFixtureTree,
} from "./capability-fixtures.mjs";

// Whether an owned public file is in the output at the graph gate (ADR 0161):
// a file a plugin emits, or `public/` holds, is; one nothing writes is not.

const tree = { tmpRoot: null, appRoot: null, inventory: null };
beforeAll(() => Object.assign(tree, makeFixtureTree()));
afterAll(() => rmSync(tree.tmpRoot, { recursive: true, force: true }));

const html = "<!doctype html><html><body></body></html>";

test("a public file is present when a plugin emits it or public/ holds it, and absent otherwise", async () => {
  const { main } = await compose(tree, { mode: "selective" });
  mkdirSync(join(tree.appRoot, "public"), { recursive: true });
  writeFileSync(join(tree.appRoot, "public", "kept.json"), "{}");
  const state = {
    ...main.__state(),
    publicFiles: [
      { path: "emitted.json", capability: "connectors.external" },
      { path: "kept.json", capability: "connectors.external" },
      { path: "later.json", capability: "connectors.external" },
    ],
  };
  const { ctx, bundle } = fakeBundle(tree.appRoot, html);
  const emitting = {
    ...bundle(),
    "emitted.json": { type: "asset", source: "{}" },
  };
  const graph = buildGraph(ctx, emitting, state, "/OpenSesame/");
  assert.deepEqual(
    graph.publicFiles.map((file) => [file.file, file.present]),
    [
      ["emitted.json", true],
      ["kept.json", true],
      ["later.json", false],
    ],
  );
});

test("with no app root to look in, presence is unknown, which the gate still treats as present", async () => {
  const { main } = await compose(tree, { mode: "selective" });
  const state = {
    ...main.__state(),
    appRoot: undefined,
    publicFiles: [{ path: "later.json", capability: "connectors.external" }],
  };
  const { ctx, bundle } = fakeBundle(tree.appRoot, html);
  const graph = buildGraph(ctx, bundle(), state, "/OpenSesame/");
  assert.equal(graph.publicFiles[0].present, undefined);
});
