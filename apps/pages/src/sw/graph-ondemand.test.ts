import { expect, it } from "vitest";
import { parseCapabilityGraph, resolvePlanAssets } from "./graph.js";

const connections = "connectors.external/runtime";
const nativeModule = "connectors.external/native-sdk";
const coreFiles = ["assets/core.js", "assets/main.js", "shell.svg"];
const connectionFiles = [
  "assets/connections.css",
  "assets/connections.js",
  "assets/shared.js",
];
const nativeAssets = [
  "assets/native-worker.js",
  "onepassword/core.mjs",
  "onepassword/core.wasm",
  "onepassword/LICENSE.txt",
];
const nativeFiles = [
  "assets/native-sdk.js",
  "assets/native-shared.js",
  ...nativeAssets,
];
type Options = {
  exactIds?: boolean;
  onlyOnDemand?: boolean;
  staticDependency?: boolean;
  coreOnDemand?: boolean;
};
function graph(options: Options = {}) {
  const owner = (moduleId: string) => {
    const entry = {
      classification: "optional",
      capability: "connectors.external",
    };
    return options.exactIds ? { ...entry, moduleId } : entry;
  };
  const parsed = parseCapabilityGraph({
    entries: [{ html: "index.html", capability: null, assets: ["shell.svg"] }],
    chunks: [
      {
        file: "assets/main.js",
        isEntry: true,
        core: true,
        onDemand: options.coreOnDemand === true,
        imports: ["assets/core.js"],
      },
      {
        file: "assets/core.js",
        modules: [{ classification: "core", capability: null }],
      },
      ...(options.onlyOnDemand
        ? []
        : [
            {
              file: "assets/connections.js",
              modules: [owner(connections)],
              imports: [
                "assets/shared.js",
                ...(options.staticDependency ? ["assets/native-sdk.js"] : []),
              ],
              dynamicImports: ["assets/native-sdk.js"],
              importedCss: ["assets/connections.css"],
            },
          ]),
      {
        file: "assets/shared.js",
        modules: [{ classification: "shared", capability: null }],
      },
      {
        file: "assets/native-sdk.js",
        modules: [owner(nativeModule)],
        onDemand: true,
        imports: ["assets/native-shared.js"],
        importedAssets: nativeAssets,
      },
      {
        file: "assets/native-shared.js",
        modules: [{ classification: "shared", capability: null }],
      },
      {
        file: "assets/wallet.js",
        modules: [
          { classification: "optional", capability: "wallet.spending" },
        ],
        importedAssets: ["wallet.wasm"],
      },
    ],
  });
  if (!parsed) throw new Error("Expected emitted graph fixture to parse");
  return parsed;
}
function files(...groups: readonly string[][]) {
  return { ok: true, files: groups.flat().sort() };
}

it("keeps on-demand assets outside capability roots with emitted ownership lacking moduleId", () => {
  const emitted = graph();
  expect(
    emitted.chunks
      .flatMap((chunk) => chunk.modules)
      .every((module) => module.moduleId === null),
  ).toBe(true);
  expect(resolvePlanAssets(emitted, [connections])).toEqual(
    files(coreFiles, connectionFiles),
  );
});
it("retains an on-demand static dependency and every owned asset", () => {
  expect(
    resolvePlanAssets(graph({ staticDependency: true }), [connections]),
  ).toEqual(files(coreFiles, connectionFiles, nativeFiles));
});
it("keeps exact ordinary module ownership without admitting its on-demand dynamic leaf", () => {
  expect(resolvePlanAssets(graph({ exactIds: true }), [connections])).toEqual(
    files(coreFiles, connectionFiles),
  );
});
it("recognizes an exact module owned only by an on-demand chunk without rooting it", () => {
  expect(resolvePlanAssets(graph({ exactIds: true }), [nativeModule])).toEqual(
    files(coreFiles),
  );
});
it("recognizes emitted capability ownership consisting only of an on-demand chunk", () => {
  expect(
    resolvePlanAssets(graph({ onlyOnDemand: true }), [connections]),
  ).toEqual(files(coreFiles));
});
it("still rejects an unknown module in a mixed request", () => {
  expect(
    resolvePlanAssets(graph(), [connections, "not.installed/runtime"]),
  ).toEqual({ ok: false, unknown: ["not.installed/runtime"] });
});
it("keeps unrelated capability roots separate and shared static dependencies intact", () => {
  expect(resolvePlanAssets(graph(), ["wallet.spending/runtime"])).toEqual(
    files(coreFiles, ["assets/wallet.js", "wallet.wasm"]),
  );
  expect(resolvePlanAssets(graph(), [])).toEqual(files(coreFiles));
});
it("preserves core entry roots even when the entry carries an on-demand tag", () => {
  expect(resolvePlanAssets(graph({ coreOnDemand: true }), [])).toEqual(
    files(coreFiles),
  );
});
