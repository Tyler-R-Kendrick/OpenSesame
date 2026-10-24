/** Remove only the unreachable SDK AJV default; the app supplies its bounded interpreter. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const pins = JSON.parse(
  readFileSync(new URL("./mcp-browser-sdk.json", import.meta.url), "utf8"),
);
const fallback =
  'options?.jsonSchemaValidator ?? (() => { throw new Error("An explicit browser JSON Schema validator is required."); })()';
const forbidden = /\/node_modules\/(?:ajv|ajv-formats|fast-uri)\//;
const digest = (value) => createHash("sha256").update(value).digest("hex");
function count(source, fragment) {
  return source.split(fragment).length - 1;
}
function requireMatch(value, expected, label) {
  if (value !== expected)
    throw new Error(`MCP browser validator pin mismatch: ${label}`);
}

/** Raw source and its closed fragments are checked before any dependency edit. */
export function validateMcpBrowserInputs(input) {
  requireMatch(digest(input.packageSource), pins.packageSHA256, "package");
  const metadata = JSON.parse(input.packageSource);
  requireMatch(metadata.name, pins.packageName, "package name");
  requireMatch(metadata.version, pins.packageVersion, "version");
  requireMatch(digest(input.clientSource), pins.clientSHA256, "client");
  requireMatch(digest(input.appSource), pins.appSHA256, "application");
  requireMatch(
    count(input.clientSource, pins.fragments.sdkImport),
    1,
    "import",
  );
  requireMatch(
    count(input.clientSource, pins.fragments.sdkDefault),
    1,
    "default",
  );
  requireMatch(
    count(input.clientSource, "AjvJsonSchemaValidator"),
    2,
    "AJV references",
  );
  requireMatch(
    count(input.appSource, pins.fragments.appInjection),
    1,
    "injection",
  );
  requireMatch(count(input.appSource, "new Client("), 1, "sole constructor");
}

/** Resolve the dependency from its actual core owner, never a Pages peer or cwd. */
export function readMcpBrowserInputs(repositoryRoot) {
  const owner = createRequire(
    resolve(repositoryRoot, "packages/app-core/package.json"),
  );
  const required = realpathSync(
    owner.resolve("@modelcontextprotocol/sdk/client/index.js"),
  );
  const suffix = "/dist/cjs/client/index.js";
  // realpathSync yields platform separators; the suffix is spelled with `/`.
  const normalized = required.replaceAll("\\", "/");
  if (!normalized.endsWith(suffix))
    throw new Error("Unexpected MCP client layout");
  const packageRoot = normalized.slice(0, -suffix.length);
  // Rollup module ids use `/` on every platform; keep the validator's own
  // paths in that space so graph comparisons compare like with like.
  const clientPath = realpathSync(
    resolve(packageRoot, "dist/esm/client/index.js"),
  ).replaceAll("\\", "/");
  const appPath = realpathSync(
    resolve(repositoryRoot, pins.appRelativePath),
  ).replaceAll("\\", "/");
  // Pins are content hashes; a checkout may materialize the app source with
  // platform line endings (core.autocrlf), so hash its LF-normalized bytes.
  const input = {
    packageSource: readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    clientSource: readFileSync(clientPath, "utf8"),
    appSource: readFileSync(appPath, "utf8").replaceAll("\r\n", "\n"),
  };
  validateMcpBrowserInputs(input);
  return { ...input, clientPath, appPath, packageRoot };
}

/** No protocol, transport or supplied validator code changes. Missing injection fails closed. */
export function transformMcpBrowserClient(source) {
  requireMatch(digest(source), pins.clientSHA256, "transform source");
  requireMatch(count(source, pins.fragments.sdkImport), 1, "transform import");
  requireMatch(
    count(source, pins.fragments.sdkDefault),
    1,
    "transform default",
  );
  const code = source
    .replace(pins.fragments.sdkImport, "")
    .replace(pins.fragments.sdkDefault, fallback);
  requireMatch(count(code, "AjvJsonSchemaValidator"), 0, "remaining AJV");
  return { code, map: null };
}

function assertClientGraph(context, clientPath, appPath) {
  const ids = [...context.getModuleIds()];
  const sdkClient =
    /\/node_modules\/@modelcontextprotocol\/sdk\/dist\/(?:esm|cjs)\/client\/index\.js(?:\?|$)/;
  if (
    ids.some(
      (id) => sdkClient.test(id.replaceAll("\\", "/")) && id !== clientPath,
    )
  )
    throw new Error("Unexpected MCP browser SDK client module");
  const client = context.getModuleInfo(clientPath);
  if (!client) return false;
  const importers = [...client.importers, ...client.dynamicImporters];
  if (!importers.length || importers.some((id) => id !== appPath))
    throw new Error("Unexpected MCP browser client importer");
  for (const id of ids)
    if (forbidden.test(id.replaceAll("\\", "/")))
      throw new Error("MCP browser build retained an AJV default dependency");
  if (
    !ids.includes(
      resolve(dirname(appPath), "native-mcp-schema-validator.ts").replaceAll(
        "\\",
        "/",
      ),
    ) ||
    !ids.some((id) =>
      id.replaceAll("\\", "/").includes("/node_modules/@cfworker/json-schema/"),
    )
  )
    throw new Error("MCP browser build lost the supplied bounded interpreter");
  return true;
}

/** Closed build-only optimization. Profiles without MCP acquire no runtime dependency. */
export function mcpBrowserValidator(repositoryRoot) {
  let input;
  let transformed = 0;
  return {
    name: "mcp-explicit-browser-validator",
    apply: "build",
    enforce: "pre",
    buildStart() {
      input = readMcpBrowserInputs(repositoryRoot);
      transformed = 0;
    },
    transform(source, id) {
      if (!input) throw new Error("MCP browser validator was not initialized");
      if (id !== input.clientPath) return null;
      const result = transformMcpBrowserClient(source);
      transformed += 1;
      return result;
    },
    generateBundle() {
      if (!input) throw new Error("MCP browser validator was not initialized");
      const present = assertClientGraph(this, input.clientPath, input.appPath);
      if (present && transformed !== 1)
        throw new Error("MCP browser client was not transformed exactly once");
    },
  };
}
