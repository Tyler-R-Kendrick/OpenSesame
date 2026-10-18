import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { emittedTailnetWorker } from "./tailscale-installed-pwa-browser.mjs";

const worker = "assets/tailscale-node-real123.js";
const bridge = "tailscale/native-http-8aae084a520add2b.js";
const controller = "assets/controller.js";
const workerRecord = (file) => ({
  file,
  capability: "networking.tailnet",
  variant: "module:tailscale-node",
  present: true,
});
const birth = (reference) =>
  `new Worker(new URL(${JSON.stringify(reference)},import.meta.url).href,{type:"module"});`;
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "native-worker-discovery-"));
  const graph = {
    chunks: [
      {
        file: controller,
        modules: [
          { id: "/src/modules/networking.tailnet/browser/controller.ts" },
        ],
      },
    ],
    assets: [{ file: worker }, { file: bridge }],
    workers: [workerRecord(worker)],
  };
  const save = async (code) => {
    await writeFile(
      join(directory, "capability-graph.json"),
      JSON.stringify(graph),
    );
    await writeFile(join(directory, controller), code);
  };
  try {
    await mkdir(join(directory, "assets"));
    await writeFile(join(directory, worker), "export {};\n");
    await save(birth("tailscale-node-real123.js"));
    await run({ directory, graph, save });
  } finally {
    await rm(directory, { recursive: true });
  }
}

test("installed-PWA discovery resolves the actual emitted relative worker URL and ignores the native bridge", () =>
  fixture(async ({ directory, save }) => {
    await save(
      `${birth("tailscale-node-real123.js")}const bridge=${JSON.stringify(bridge)};`,
    );
    assert.equal(emittedTailnetWorker(directory, "/OpenSesame/"), worker);
    await save(birth("./tailscale-node-real123.js"));
    assert.equal(emittedTailnetWorker(directory, "/"), worker);
    await save(birth("/OpenSesame/assets/tailscale-node-real123.js"));
    assert.equal(emittedTailnetWorker(directory, "/OpenSesame/"), worker);
  }));

test("discovery keeps exact worker cardinality and requires both delivery and dedicated-worker inventories", () =>
  fixture(async ({ directory, graph, save }) => {
    const second = "assets/tailscale-node-second.js";
    graph.assets.push({ file: second });
    graph.workers.push(workerRecord(second));
    await save(
      `${birth("tailscale-node-real123.js")}${birth("tailscale-node-second.js")}`,
    );
    assert.throws(() => emittedTailnetWorker(directory), /exactly one/);
    graph.assets = [{ file: bridge }];
    await save(birth("tailscale-node-real123.js"));
    assert.throws(() => emittedTailnetWorker(directory), /exactly one/);
    graph.assets = [{ file: worker }];
    graph.workers = [];
    await save(birth("tailscale-node-real123.js"));
    assert.throws(() => emittedTailnetWorker(directory), /exactly one/);
    graph.workers = [workerRecord(worker), workerRecord(worker)];
    await save(birth("tailscale-node-real123.js"));
    assert.throws(() => emittedTailnetWorker(directory), /exactly one/);
  }));

test("ordinary strings, comments, dynamic URLs and unrelated URL constructors cannot prove worker ownership", () =>
  fixture(async ({ directory, save }) => {
    for (const code of [
      JSON.stringify([worker, bridge]),
      `// ${birth("tailscale-node-real123.js")}`,
      `new URL("tailscale-node-real123.js",import.meta.url);`,
      "new Worker(new URL(name,import.meta.url));",
      'new Worker(new URL("tailscale-node-real123.js",location.href));',
    ]) {
      await save(code);
      assert.throws(() => emittedTailnetWorker(directory), /exactly one/);
    }
  }));

test("worker URLs cannot escape the deployment or carry foreign origins, traversal or query state", () =>
  fixture(async ({ directory, save }) => {
    for (const reference of [
      "https://foreign.test/OpenSesame/assets/tailscale-node-real123.js",
      "//foreign.test/assets/tailscale-node-real123.js",
      "/different/assets/tailscale-node-real123.js",
      "../assets/tailscale-node-real123.js",
      "tailscale-node-real123.js?token=x",
      "tailscale-node-real123.js#fragment",
      "%74ailscale-node-real123.js",
      "..\\assets\\tailscale-node-real123.js",
    ]) {
      await save(birth(reference));
      assert.throws(
        () => emittedTailnetWorker(directory, "/OpenSesame/"),
        /exactly one/,
      );
    }
    assert.throws(
      () => emittedTailnetWorker(directory, "/../"),
      /deployment base/,
    );
  }));

test("discovery rejects missing or ambiguous controller owners and unowned controller paths", () =>
  fixture(async ({ directory, graph, save }) => {
    const owner = graph.chunks[0];
    graph.chunks = [];
    await save(birth("tailscale-node-real123.js"));
    assert.throws(
      () => emittedTailnetWorker(directory),
      /no Tailscale controller owner/,
    );
    graph.chunks = [owner, owner];
    await save(birth("tailscale-node-real123.js"));
    assert.throws(() => emittedTailnetWorker(directory), /ambiguous/);
    graph.chunks = [{ ...owner, file: "../controller.js" }];
    await save(birth("tailscale-node-real123.js"));
    assert.throws(() => emittedTailnetWorker(directory), /owned asset/);
  }));

test("worker and controller paths must be regular files with no symlink escape", () =>
  fixture(async ({ directory, save }) => {
    await save(birth("tailscale-node-real123.js"));
    await rm(join(directory, worker));
    await symlink(join(directory, controller), join(directory, worker));
    assert.throws(() => emittedTailnetWorker(directory), /regular owned file/);
    await rm(join(directory, worker));
    await writeFile(join(directory, worker), "export {};\n");
    await rm(join(directory, controller));
    await symlink(join(directory, worker), join(directory, controller));
    assert.throws(() => emittedTailnetWorker(directory), /regular owned file/);
    await rm(join(directory, "assets"), { recursive: true });
    await mkdir(join(directory, "elsewhere"));
    await writeFile(
      join(directory, "elsewhere/controller.js"),
      birth("tailscale-node-real123.js"),
    );
    await writeFile(
      join(directory, "elsewhere/tailscale-node-real123.js"),
      "export {};\n",
    );
    await symlink(join(directory, "elsewhere"), join(directory, "assets"));
    assert.throws(() => emittedTailnetWorker(directory), /regular owned file/);
  }));
