import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  mcpBrowserValidator,
  readMcpBrowserInputs,
  transformMcpBrowserClient,
  validateMcpBrowserInputs,
} from "./mcp-browser-validator.mjs";

const root = existsSync(resolve(process.cwd(), "pnpm-workspace.yaml"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");
const input = readMcpBrowserInputs(root);
function graph(importers = [input.appPath], extra = []) {
  return {
    getModuleInfo: (id) =>
      id === input.clientPath ? { importers, dynamicImporters: [] } : null,
    getModuleIds: () => [
      input.clientPath,
      resolve(dirname(input.appPath), "native-mcp-schema-validator.ts"),
      "/fixture/node_modules/@cfworker/json-schema/dist/esm/validate.js",
      ...extra,
    ],
  };
}
function started() {
  const plugin = mcpBrowserValidator(root);
  plugin.buildStart();
  return plugin;
}

it("admits the exact owned package, SDK client and existing explicit validator injection", () => {
  expect(() => validateMcpBrowserInputs(input)).not.toThrow();
  expect(input.clientPath).toContain("/dist/esm/client/index.js");
  expect(input.appSource).toContain("jsonSchemaValidator: this.inputValidator");
});
it.each([
  {
    packageSource: input.packageSource.replace(
      /"version":\s*"[^"]+"/,
      '"version": "1.32.1"',
    ),
  },
  { packageSource: `${input.packageSource}\n` },
  { clientSource: `${input.clientSource}\n` },
  {
    clientSource: input.clientSource.replace(
      "new AjvJsonSchemaValidator()",
      "acceptAnySchema()",
    ),
  },
  {
    clientSource: input.clientSource.replace(
      "new AjvJsonSchemaValidator()",
      "new AjvJsonSchemaValidator() ?? new AjvJsonSchemaValidator()",
    ),
  },
  {
    appSource: input.appSource.replace(
      "jsonSchemaValidator: this.inputValidator",
      "jsonSchemaValidator: undefined",
    ),
  },
  { appSource: `${input.appSource}\nnew Client({});\n` },
])("rejects drift or removed/duplicate constructor injection %#", (change) => {
  expect(() => validateMcpBrowserInputs({ ...input, ...change })).toThrow(
    "pin mismatch",
  );
});
it("changes only the unused import and missing-validator fallback, leaving the entire SDK protocol intact", () => {
  const { code, map } = transformMcpBrowserClient(input.clientSource);
  expect(map).toBeNull();
  expect(code).not.toContain("AjvJsonSchemaValidator");
  const restored = code
    .replace(
      "\n\nimport { getLiteralValue",
      "\nimport { AjvJsonSchemaValidator } from '../validation/ajv-provider.js';\nimport { getLiteralValue",
    )
    .replace(
      'options?.jsonSchemaValidator ?? (() => { throw new Error("An explicit browser JSON Schema validator is required."); })()',
      "options?.jsonSchemaValidator ?? new AjvJsonSchemaValidator()",
    );
  expect(restored).toBe(input.clientSource);
  expect(code).toContain(
    "this._jsonSchemaValidator.getValidator(tool.outputSchema)",
  );
});
it.each([
  "",
  `${input.clientSource}\n`,
  input.clientSource.replace("../validation/ajv-provider.js", "./other.js"),
])("refuses unpinned transform source %#", (source) => {
  expect(() => transformMcpBrowserClient(source)).toThrow("pin mismatch");
});
it("is build-only and does not rewrite unrelated modules or alternate peer versions", () => {
  const plugin = started();
  expect(plugin.apply).toBe("build");
  expect(plugin.transform("unrelated", input.appPath)).toBeNull();
  expect(
    plugin.transform(
      "unrelated",
      input.clientPath.replace(
        /@modelcontextprotocol\+sdk@[^/]+/,
        "@modelcontextprotocol+sdk@1.30.0",
      ),
    ),
  ).toBeNull();
  expect(plugin.transform("unrelated", `${input.clientPath}?other`)).toBeNull();
});
it("requires lifecycle initialization and exactly one actual client transform", () => {
  expect(() =>
    mcpBrowserValidator(root).transform(input.clientSource, input.clientPath),
  ).toThrow("initialized");
  expect(() => started().generateBundle.call(graph())).toThrow("exactly once");
  const plugin = started();
  plugin.transform(input.clientSource, input.clientPath);
  plugin.transform(input.clientSource, input.clientPath);
  expect(() => plugin.generateBundle.call(graph())).toThrow("exactly once");
});
it("keeps no-MCP profiles valid without loading a validator runtime", () => {
  expect(() =>
    started().generateBundle.call({
      getModuleInfo: () => null,
      getModuleIds: () => [],
    }),
  ).not.toThrow();
});
it.each([
  { importers: [] },
  { importers: ["/fixture/unreviewed.ts"] },
  { importers: [input.appPath, "/fixture/second.ts"] },
])("rejects unexpected SDK client importers %#", ({ importers }) => {
  const plugin = started();
  plugin.transform(input.clientSource, input.clientPath);
  expect(() => plugin.generateBundle.call(graph(importers))).toThrow(
    "importer",
  );
});
it.each(["ajv", "ajv-formats", "fast-uri"])(
  "rejects retained default compiler dependency %s",
  (name) => {
    const plugin = started();
    plugin.transform(input.clientSource, input.clientPath);
    expect(() =>
      plugin.generateBundle.call(
        graph(undefined, [`/fixture/node_modules/${name}/index.js`]),
      ),
    ).toThrow("retained");
  },
);
it("requires the actual bounded interpreter and CfWorker graph", () => {
  const plugin = started();
  plugin.transform(input.clientSource, input.clientPath);
  const context = graph();
  context.getModuleIds = () => [input.clientPath];
  expect(() => plugin.generateBundle.call(context)).toThrow("lost");
});
it("accepts the sole supplied-validator graph and rechecks source drift at transformation", () => {
  const plugin = started();
  expect(() =>
    plugin.transform(`${input.clientSource}\n`, input.clientPath),
  ).toThrow("pin mismatch");
  plugin.transform(input.clientSource, input.clientPath);
  expect(() => plugin.generateBundle.call(graph())).not.toThrow();
});

it.each([
  input.clientPath.replace("/dist/esm/", "/dist/cjs/"),
  `${input.clientPath}?unexpected`,
])(
  "refuses an alternate SDK module even when the expected client is absent: %s",
  (clientPath) => {
    expect(() =>
      started().generateBundle.call({
        getModuleInfo: () => null,
        getModuleIds: () => [clientPath],
      }),
    ).toThrow("Unexpected MCP browser SDK client module");
  },
);
