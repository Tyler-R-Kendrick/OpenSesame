/** Keep the official SDK's explicit browser model, without an implicit remote provider. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const pins = JSON.parse(
  readFileSync(new URL("./ai-browser-sdk.json", import.meta.url), "utf8"),
);
const refusal = "An explicit browser language-model object is required.";
const digest = (source) => createHash("sha256").update(source).digest("hex");
const normalized = (path) => path.replaceAll("\\", "/");
const occurrences = (source, fragment) => source.split(fragment).length - 1;
function requireMatch(value, expected, label) {
  if (value !== expected)
    throw new Error(`Browser AI SDK pin mismatch: ${label}`);
}

function packageInput(source, expected, label) {
  requireMatch(digest(source), expected.sha256, `${label} package`);
  const metadata = JSON.parse(source);
  requireMatch(metadata.name, expected.name, `${label} name`);
  requireMatch(metadata.version, expected.version, `${label} version`);
  requireMatch(metadata.sideEffects, false, `${label} side effects`);
}

/** Updates must review both upstream implementations and the closed application boundary. */
export function validateAiBrowserInputs(input) {
  packageInput(input.sdkPackageSource, pins.sdk, "SDK");
  packageInput(input.gatewayPackageSource, pins.gateway, "gateway");
  for (const [name, expected] of Object.entries(pins.sources))
    requireMatch(digest(input[name]), expected, name);
  for (const [name, source] of [
    ["sdkDefault", input.sdkSource],
    ["gatewayDefault", input.gatewaySource],
    ["facadeGuard", input.facadeSource],
    ["facadeDelegate", input.facadeSource],
    ["callerModel", input.callerSource],
  ])
    requireMatch(occurrences(source, pins.fragments[name]), 1, name);
}

/** Resolve from the actual core owner and its actual SDK, never another workspace copy. */
export function readAiBrowserInputs(repositoryRoot) {
  const owner = createRequire(
    resolve(repositoryRoot, "packages/app-core/package.json"),
  );
  const sdkPath = normalized(realpathSync(owner.resolve("ai")));
  if (!sdkPath.endsWith("/dist/index.js"))
    throw new Error("Unexpected browser AI SDK layout");
  const sdkRoot = resolve(dirname(sdkPath), "..");
  const gatewayPath = normalized(
    realpathSync(createRequire(sdkPath).resolve("@ai-sdk/gateway")),
  );
  if (!gatewayPath.endsWith("/dist/index.js"))
    throw new Error("Unexpected browser AI gateway layout");
  const gatewayRoot = resolve(dirname(gatewayPath), "..");
  const facadePath = normalized(
    realpathSync(resolve(repositoryRoot, pins.facade)),
  );
  const callerPath = normalized(
    realpathSync(resolve(repositoryRoot, pins.caller)),
  );
  const input = {
    sdkPackageSource: readFileSync(resolve(sdkRoot, "package.json"), "utf8"),
    gatewayPackageSource: readFileSync(
      resolve(gatewayRoot, "package.json"),
      "utf8",
    ),
    sdkSource: readFileSync(sdkPath, "utf8"),
    gatewaySource: readFileSync(gatewayPath, "utf8"),
    facadeSource: readFileSync(facadePath, "utf8").replaceAll("\r\n", "\n"),
    callerSource: readFileSync(callerPath, "utf8").replaceAll("\r\n", "\n"),
  };
  validateAiBrowserInputs(input);
  return { ...input, sdkPath, gatewayPath, facadePath, callerPath };
}

/** Object models keep the SDK's adapters, schemas, retries, errors and cancellation. */
export function transformAiBrowserSdk(source) {
  requireMatch(digest(source), pins.sources.sdkSource, "SDK transform source");
  requireMatch(
    occurrences(source, pins.fragments.sdkDefault),
    1,
    "SDK default",
  );
  return {
    code: source.replace(
      pins.fragments.sdkDefault,
      `function getGlobalProvider() { throw new Error(${JSON.stringify(refusal)}); }`,
    ),
    map: null,
  };
}

/**
 * The reviewed no-argument factory only allocates a local provider and closures;
 * credentials and HTTP are read by its unused methods. Mark only this exact
 * initializer pure. The official error classes remain unmodified.
 */
export function transformAiBrowserGateway(source) {
  requireMatch(
    digest(source),
    pins.sources.gatewaySource,
    "gateway transform source",
  );
  requireMatch(
    occurrences(source, pins.fragments.gatewayDefault),
    1,
    "gateway default",
  );
  return {
    code: source.replace(
      pins.fragments.gatewayDefault,
      "const gateway = /* @__PURE__ */ createGateway();",
    ),
    map: null,
  };
}

function importersAre(context, path, allowed) {
  const info = context.getModuleInfo(path);
  if (!info || info.isEntry)
    throw new Error("Browser AI SDK needs its closed application importers");
  const importers = [...info.importers, ...info.dynamicImporters];
  if (!importers.length || importers.some((id) => id !== allowed))
    throw new Error("Unexpected browser AI SDK importer");
}

/** Additional SDK copies, direct calls and gateway imports require a new review. */
export function assertAiBrowserGraph(context, input) {
  const ids = [...context.getModuleIds()];
  const sdkModule = /\/node_modules\/ai\/dist\/index\.(?:js|mjs)(?:\?|$)/;
  const gatewayModule =
    /\/node_modules\/@ai-sdk\/gateway\/dist\/index\.(?:js|mjs)(?:\?|$)/;
  for (const id of ids) {
    const path = normalized(id);
    if (
      (sdkModule.test(path) && path !== input.sdkPath) ||
      (gatewayModule.test(path) && path !== input.gatewayPath)
    )
      throw new Error("Unexpected browser AI SDK dependency copy");
  }
  if (!ids.includes(input.sdkPath)) {
    if (ids.includes(input.gatewayPath))
      throw new Error("Browser gateway appeared without the reviewed SDK");
    return false;
  }
  importersAre(context, input.sdkPath, input.facadePath);
  importersAre(context, input.facadePath, input.callerPath);
  importersAre(context, input.gatewayPath, input.sdkPath);
  if (!ids.includes(input.callerPath))
    throw new Error("Browser AI SDK lost its reviewed caller");
  return true;
}

/** Class-only dependency is truthful: no provider constructor/auth/HTTP survives. */
export function assertAiBrowserOutput(bundle, input) {
  const modules = Object.values(bundle)
    .filter((entry) => entry.type === "chunk")
    .flatMap((entry) => Object.entries(entry.modules))
    .filter(([id]) => normalized(id) === input.gatewayPath);
  requireMatch(modules.length, 1, "emitted gateway error module");
  const info = modules[0][1];
  requireMatch(
    info.renderedLength,
    pins.gatewayErrorRenderedBytes,
    "class-only bytes",
  );
  requireMatch(
    JSON.stringify([...info.renderedExports].sort()),
    JSON.stringify(["GatewayAuthenticationError", "GatewayError"]),
    "official error exports",
  );
  for (const chunk of Object.values(bundle))
    if (
      chunk.type === "chunk" &&
      pins.forbiddenRuntimeFragments.some((fragment) =>
        chunk.code.includes(fragment),
      )
    )
      throw new Error("Browser AI gateway provider runtime survived");
}

/** Closed build-only optimization; remote CUA and every other application stay untouched. */
export function aiBrowserModels(repositoryRoot) {
  let input;
  let sdkTransforms = 0;
  let gatewayTransforms = 0;
  return {
    name: "ai-explicit-browser-models",
    apply: "build",
    enforce: "pre",
    buildStart() {
      input = readAiBrowserInputs(repositoryRoot);
      sdkTransforms = 0;
      gatewayTransforms = 0;
    },
    transform(source, id) {
      if (!input) throw new Error("Browser AI SDK was not initialized");
      if (id === input.sdkPath) {
        sdkTransforms += 1;
        return transformAiBrowserSdk(source);
      }
      if (id === input.gatewayPath) {
        gatewayTransforms += 1;
        return transformAiBrowserGateway(source);
      }
      return null;
    },
    generateBundle(_options, bundle) {
      if (!input) throw new Error("Browser AI SDK was not initialized");
      const present = assertAiBrowserGraph(this, input);
      requireMatch(sdkTransforms, present ? 1 : 0, "SDK transform count");
      requireMatch(
        gatewayTransforms,
        present ? 1 : 0,
        "gateway transform count",
      );
      if (present) assertAiBrowserOutput(bundle, input);
    },
  };
}
