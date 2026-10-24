/** Preserve the pinned browser verifier while removing CommonJS namespace augmentation. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const pins = {
  oidcPackage:
    "7a15c10cedf7f7796c151f211b49277fc50d47da57e66de9835b4e50fd7169e4",
  oidcBrowser:
    "88827584f41f0ec9833d15c6897dc4a09dd753b6574d0fba6b50831319d65dd8",
  verifier: "af1abbd1023f7a7e7b55e4cf7e74aa7e18ec676e49b76efb71826e122debf48b",
  josePackage:
    "3cb0f73674b50b4e99f35c883e10c9e541e3b8d20368825379515547af1d804d",
  joseBrowser:
    "44c315d5a0ffabb93fa3e70be939e468b1de6c2ca425742e81c8bab826af9ff4",
  connectPackage:
    "ffd9bf1a42c6fad122cf7910612a29e12ef900dc143d08351eb763422d30efe8",
};
const digest = (source) => createHash("sha256").update(source).digest("hex");
function equal(actual, expected, name) {
  if (actual !== expected)
    throw new Error(`OIDC namespace pin mismatch: ${name}`);
}
function packageRoot(entry, suffix) {
  // realpathSync yields platform separators; the suffix is spelled with `/`.
  const normalized = entry.replaceAll("\\", "/");
  if (!normalized.endsWith(suffix))
    throw new Error("Unexpected OIDC dependency layout");
  return normalized.slice(0, -suffix.length);
}
export function checkOidcNamespaceSource(name, source) {
  if (!Object.hasOwn(pins, name))
    throw new Error("Unknown OIDC namespace input");
  equal(digest(source), pins[name], name);
  return source;
}
function checked(path, name) {
  return checkOidcNamespaceSource(name, readFileSync(path, "utf8"));
}
/** Resolve from the actual SDK owner, never from a hoisted peer. */
export function readOidcNamespaceInputs(root) {
  const owner = createRequire(resolve(root, "packages/app-core/package.json"));
  const connect = realpathSync(owner.resolve("@vercel/connect"));
  const connectRoot = packageRoot(connect, "/dist/index.js");
  checked(resolve(connectRoot, "package.json"), "connectPackage");
  const oidc = realpathSync(createRequire(connect).resolve("@vercel/oidc"));
  const oidcRoot = packageRoot(oidc, "/dist/index.js");
  const metadata = JSON.parse(
    checked(resolve(oidcRoot, "package.json"), "oidcPackage"),
  );
  equal(metadata.version, "3.8.8", "OIDC version");
  equal(
    metadata.exports["."].browser,
    "./dist/index-browser.js",
    "public browser entry",
  );
  const browser = realpathSync(
    resolve(oidcRoot, metadata.exports["."].browser),
  );
  checked(browser, "oidcBrowser");
  const verifier = realpathSync(
    resolve(oidcRoot, "dist/verify-vercel-oidc-token.js"),
  );
  checked(verifier, "verifier");
  const jose = realpathSync(createRequire(oidc).resolve("jose"));
  const joseRoot = packageRoot(jose, "/dist/node/cjs/index.js");
  const joseMetadata = JSON.parse(
    checked(resolve(joseRoot, "package.json"), "josePackage"),
  );
  equal(joseMetadata.version, "5.10.0", "JOSE version");
  const target = realpathSync(
    resolve(joseRoot, joseMetadata.exports["."].browser),
  );
  checked(target, "joseBrowser");
  return { browser, verifier, target };
}
/** Only this exact namespace consumer differs; every other setting is delegated unchanged. */
export function oidcNamespaceOption(target) {
  return (id) => (id === target ? "namespace" : false);
}

function assertConsumers(context, { target, verifier }) {
  const info = context.getModuleInfo(target);
  if (!info) return;
  const consumers = [];
  for (const id of [...info.importers, ...info.dynamicImporters]) {
    if (id === `\0${target}?commonjs-proxy`) {
      const proxy = context.getModuleInfo(id);
      if (!proxy) throw new Error("Missing OIDC namespace proxy");
      consumers.push(...proxy.importers, ...proxy.dynamicImporters);
    } else consumers.push(id);
  }
  if (!consumers.length || consumers.some((id) => id !== verifier))
    throw new Error("Unexpected JOSE browser namespace consumer");
}
/** Pages client build only; Node/SSR and original SDK sources are unchanged. */
export function vercelOidcNamespace(root) {
  let input;
  let active = false;
  return {
    name: "vercel-oidc-original-namespace",
    apply: "build",
    config(config, environment) {
      active = !environment.isSsrBuild && !config.build?.ssr;
      if (!active) return;
      if (config.build?.commonjsOptions?.requireReturnsDefault !== undefined)
        throw new Error(
          "Review existing CommonJS interop before normalizing OIDC",
        );
      input = readOidcNamespaceInputs(root);
      return {
        build: {
          commonjsOptions: {
            requireReturnsDefault: oidcNamespaceOption(input.target),
          },
        },
      };
    },
    generateBundle() {
      if (active && input) assertConsumers(this, input);
    },
  };
}
