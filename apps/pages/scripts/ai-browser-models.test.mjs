import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  aiBrowserModels,
  assertAiBrowserGraph,
  assertAiBrowserOutput,
  readAiBrowserInputs,
  transformAiBrowserGateway,
  transformAiBrowserSdk,
  validateAiBrowserInputs,
} from "./ai-browser-models.mjs";

const root = existsSync(resolve(process.cwd(), "pnpm-workspace.yaml"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");
const input = readAiBrowserInputs(root);

function graph(records, extra = []) {
  const ids = [...records.keys(), ...extra];
  return { getModuleIds: () => ids, getModuleInfo: (id) => records.get(id) };
}
function admitted() {
  return new Map([
    [input.sdkPath, { importers: [input.facadePath], dynamicImporters: [] }],
    [input.gatewayPath, { importers: [input.sdkPath], dynamicImporters: [] }],
    [input.facadePath, { importers: [], dynamicImporters: [input.callerPath] }],
    [input.callerPath, { importers: [], dynamicImporters: [] }],
  ]);
}

it("accepts the actual pinned dependency and closed application boundary", () => {
  expect(() => validateAiBrowserInputs(input)).not.toThrow();
  expect(assertAiBrowserGraph(graph(admitted()), input)).toBe(true);
  expect(assertAiBrowserGraph(graph(new Map()), input)).toBe(false);
});

it.each([
  "sdkPackageSource",
  "gatewayPackageSource",
  "sdkSource",
  "gatewaySource",
  "facadeSource",
  "callerSource",
])("fails closed when reviewed %s bytes change", (name) => {
  expect(() =>
    validateAiBrowserInputs({ ...input, [name]: `${input[name]}\n` }),
  ).toThrow("Browser AI SDK pin mismatch");
});

it("refuses changed dependency source before either transform", () => {
  expect(() => transformAiBrowserSdk(`${input.sdkSource}\n`)).toThrow(
    "pin mismatch",
  );
  expect(() => transformAiBrowserGateway(`${input.gatewaySource}\n`)).toThrow(
    "pin mismatch",
  );
});

it.each([
  [input.sdkPath, "/unreviewed/direct-sdk.ts"],
  [input.gatewayPath, input.facadePath],
  [input.facadePath, "/unreviewed/other-consumer.ts"],
])("rejects a new importer of %s", (path, importer) => {
  const records = admitted();
  records.get(path).importers.push(importer);
  expect(() => assertAiBrowserGraph(graph(records), input)).toThrow("importer");
});

it("rejects entry-point bypass, another SDK copy and an orphan gateway", () => {
  const records = admitted();
  records.get(input.sdkPath).isEntry = true;
  expect(() => assertAiBrowserGraph(graph(records), input)).toThrow(
    "closed application",
  );
  expect(() =>
    assertAiBrowserGraph(
      graph(admitted(), ["/other/node_modules/ai/dist/index.js"]),
      input,
    ),
  ).toThrow("dependency copy");
  expect(() =>
    assertAiBrowserGraph(
      graph(
        new Map([[input.gatewayPath, { importers: [], dynamicImporters: [] }]]),
      ),
      input,
    ),
  ).toThrow("without the reviewed SDK");
});

it("requires both actual transforms and ignores unrelated applications", () => {
  const plugin = aiBrowserModels(root);
  expect(() => plugin.transform("", input.sdkPath)).toThrow("not initialized");
  plugin.buildStart();
  expect(plugin.transform("unrelated", "/cua/ai-decisions.ts")).toBeNull();
  expect(() => plugin.generateBundle.call(graph(admitted()), {}, {})).toThrow(
    "SDK transform count",
  );
});

const scratch = resolve(root, "work/ai-browser-models");
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const temporary = mkdtempSync(resolve(scratch, "compiled-parity-"));
let baseline;
let transformed;
let compiled;
const unexpectedFetch = vi.fn(async () => {
  throw new Error("Unexpected remote model request");
});

async function bundleOfficialSdk(changed) {
  const entry = resolve(temporary, "entry.ts");
  writeFileSync(
    entry,
    [
      `export { generateObject } from ${JSON.stringify(input.facadePath)};`,
      `export { generateObject as rawGenerateObject } from ${JSON.stringify(input.sdkPath)};`,
      `export { GatewayError, GatewayAuthenticationError } from ${JSON.stringify(input.gatewayPath)};`,
      `export { createPromptLanguageModel } from ${JSON.stringify(resolve(root, "packages/app-core/src/lib/command-bar/prompt-model.ts"))};`,
      'import { z } from "zod";',
      'export const schema = z.strictObject({ value: z.literal("ok") });',
    ].join("\n"),
  );
  const result = await build({
    configFile: false,
    envFile: false,
    root: resolve(root, "apps/pages"),
    publicDir: false,
    logLevel: "error",
    plugins: [
      {
        name: "actual-browser-ai-parity",
        enforce: "pre",
        transform(source, id) {
          if (!changed) return null;
          if (id === input.sdkPath) return transformAiBrowserSdk(source);
          if (id === input.gatewayPath)
            return transformAiBrowserGateway(source);
          return null;
        },
      },
    ],
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      target: "es2022",
      lib: { entry, formats: ["es"] },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  expect(output).toHaveLength(1);
  expect(output[0].type).toBe("chunk");
  const path = resolve(
    temporary,
    `${changed ? "transformed" : "baseline"}.mjs`,
  );
  writeFileSync(path, output[0].code);
  return { namespace: await import(pathToFileURL(path).href), output };
}

beforeAll(async () => {
  vi.stubGlobal("fetch", unexpectedFetch);
  baseline = (await bundleOfficialSdk(false)).namespace;
  const result = await bundleOfficialSdk(true);
  transformed = result.namespace;
  compiled = Object.fromEntries(
    result.output.map((entry) => [entry.fileName, entry]),
  );
});
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
afterEach(() => {
  try {
    expect(unexpectedFetch).not.toHaveBeenCalled();
  } finally {
    unexpectedFetch.mockClear();
    vi.unstubAllGlobals();
  }
});

function options(sdk, reply, extra = {}) {
  return {
    model: sdk.createPromptLanguageModel({
      api: {
        availability: async () => "available",
        create: async () => ({ prompt: reply, destroy() {} }),
      },
    }),
    schema: sdk.schema,
    prompt: "Return the synthetic fixture value",
    maxRetries: 0,
    ...extra,
  };
}
async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected actual SDK refusal");
}

it("the compiled gateway retains exactly official errors and no network provider", () => {
  expect(() => assertAiBrowserOutput(compiled, input)).not.toThrow();
  const chunk = Object.values(compiled)[0];
  const wrongExports = {
    ...chunk,
    modules: {
      ...chunk.modules,
      [input.gatewayPath]: {
        ...chunk.modules[input.gatewayPath],
        renderedExports: ["GatewayError", "gateway"],
      },
    },
  };
  expect(() => assertAiBrowserOutput({ wrongExports }, input)).toThrow(
    "official error exports",
  );
  const changed = {
    ...chunk,
    modules: {
      ...chunk.modules,
      [input.gatewayPath]: {
        ...chunk.modules[input.gatewayPath],
        renderedLength: 128907,
      },
    },
  };
  expect(() => assertAiBrowserOutput({ changed }, input)).toThrow(
    "class-only bytes",
  );
  expect(() =>
    assertAiBrowserOutput(
      {
        changed: {
          ...chunk,
          code: `${chunk.code}\nhttps://ai-gateway.vercel.sh/v4/ai`,
        },
      },
      input,
    ),
  ).toThrow("provider runtime survived");
});

it("actual baseline and transformed official SDK keep strict V2 output behavior", async () => {
  vi.stubGlobal("fetch", unexpectedFetch);
  for (const sdk of [baseline, transformed]) {
    const result = await sdk.generateObject(
      options(sdk, async () => '{"value":"ok"}'),
    );
    expect(result.object).toEqual({ value: "ok" });
  }
});

it.each(['{"value":"wrong"}', '{"value":"ok","extra":true}', "not JSON"])(
  "actual transformed SDK retains schema/JSON refusal for %s",
  async (reply) => {
    vi.stubGlobal("fetch", unexpectedFetch);
    const errors = [];
    for (const sdk of [baseline, transformed])
      errors.push(
        await failure(sdk.generateObject(options(sdk, async () => reply))),
      );
    expect(errors[0].name).toBe("AI_NoObjectGeneratedError");
    expect(errors[1].name).toBe(errors[0].name);
    expect(errors[1].message).toBe(errors[0].message);
  },
);

it("actual transformed SDK preserves provider and official GatewayError identities", async () => {
  vi.stubGlobal("fetch", unexpectedFetch);
  const ordinary = new Error("Synthetic local provider refusal");
  const gateway = new baseline.GatewayError({
    message: "Synthetic gateway-shaped error",
    isRetryable: false,
  });
  expect(transformed.GatewayError.isInstance(gateway)).toBe(true);
  for (const error of [ordinary, gateway])
    for (const sdk of [baseline, transformed])
      await expect(
        sdk.generateObject(
          options(sdk, async () => {
            throw error;
          }),
        ),
      ).rejects.toBe(error);
});

it("actual transformed SDK retains official authentication-error handling", async () => {
  vi.stubGlobal("fetch", unexpectedFetch);
  const error = new baseline.GatewayAuthenticationError({
    message: "Synthetic authentication error",
  });
  expect(transformed.GatewayAuthenticationError.isInstance(error)).toBe(true);
  const errors = [];
  for (const sdk of [baseline, transformed])
    errors.push(
      await failure(
        sdk.generateObject(
          options(sdk, async () => {
            throw error;
          }),
        ),
      ),
    );
  expect(errors[1].name).toBe(errors[0].name);
  expect(errors[1].message).toBe(errors[0].message);
});

it("actual transformed SDK forwards cancellation and preserves its reason", async () => {
  vi.stubGlobal("fetch", unexpectedFetch);
  const reason = new DOMException("Synthetic cancellation", "AbortError");
  for (const sdk of [baseline, transformed]) {
    const controller = new AbortController();
    controller.abort(reason);
    await expect(
      sdk.generateObject(
        options(
          sdk,
          async (_text, { signal }) => {
            signal.throwIfAborted();
            return '{"value":"ok"}';
          },
          { abortSignal: controller.signal },
        ),
      ),
    ).rejects.toBe(reason);
  }
});

it("actual SDK transform refuses the implicit provider even without the facade", async () => {
  vi.stubGlobal("fetch", unexpectedFetch);
  const languageModel = vi.fn(() => {
    throw new Error("Fixture global provider was consulted");
  });
  vi.stubGlobal("AI_SDK_DEFAULT_PROVIDER", {
    specificationVersion: "v4",
    languageModel,
  });
  const args = {
    model: "unreachable/remote",
    schema: baseline.schema,
    prompt: "Synthetic",
    maxRetries: 0,
  };
  await expect(baseline.rawGenerateObject(args)).rejects.toThrow(
    "Fixture global provider was consulted",
  );
  expect(languageModel).toHaveBeenCalledTimes(1);
  await expect(
    transformed.rawGenerateObject({ ...args, schema: transformed.schema }),
  ).rejects.toThrow("explicit browser language-model object");
  expect(languageModel).toHaveBeenCalledTimes(1);
});
