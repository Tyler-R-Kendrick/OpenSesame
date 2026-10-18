import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { emittedTailnetWorker } from "./tailscale-installed-pwa-browser.mjs";

test("installed-PWA worker discovery distinguishes the native bridge dependency and keeps exact worker cardinality", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-worker-discovery-"));
  const worker = "assets/tailscale-node-real123.js";
  const bridge = "tailscale/native-http-8aae084a520add2b.js";
  const graph = {
    chunks: [
      {
        file: "assets/controller.js",
        modules: [
          { id: "/src/modules/networking.tailnet/browser/controller.ts" },
        ],
      },
    ],
    assets: [{ file: worker }, { file: bridge }],
  };
  const save = () =>
    writeFile(join(directory, "capability-graph.json"), JSON.stringify(graph));
  try {
    await mkdir(join(directory, "assets"));
    await writeFile(
      join(directory, "assets/controller.js"),
      JSON.stringify([worker, bridge]),
    );
    await save();
    assert.equal(
      graph.assets.filter((asset) => asset.file.endsWith(".js")).length,
      2,
    );
    assert.equal(emittedTailnetWorker(directory), worker);
    const second = "assets/tailscale-node-second.js";
    graph.assets.push({ file: second });
    await writeFile(
      join(directory, "assets/controller.js"),
      JSON.stringify([worker, bridge, second]),
    );
    await save();
    assert.throws(() => emittedTailnetWorker(directory), /exactly one/);
    graph.assets = [{ file: bridge }];
    await save();
    assert.throws(() => emittedTailnetWorker(directory), /exactly one/);
    graph.chunks = [];
    await save();
    assert.throws(
      () => emittedTailnetWorker(directory),
      /no Tailscale controller owner/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
