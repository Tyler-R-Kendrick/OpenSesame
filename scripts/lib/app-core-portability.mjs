/**
 * The app-core portability check (ADR 0133 §2).
 *
 * The shared core runs in a browser tab, a CLI and a bare isolate. Outside
 * `src/browser/**` it may use only the runtime contract — the Web APIs every
 * host provides or polyfills (crypto, fetch, URL, TextEncoder, timers, …) —
 * and reaches everything else (storage, windows, WebAuthn, workers, …)
 * through a port on the host. This walks the TypeScript program and reports
 * every *value* reference that resolves to a browser-only declaration in the
 * DOM or WebWorker libs. Type references are erased at build time and never
 * count: `credential: PublicKeyCredential` is fine, `instanceof
 * PublicKeyCredential` is not.
 */
import ts from "typescript";
import { TEST_FILE } from "./app-core-boundary.mjs";

/** Globals every host provides (browsers and Node natively; an isolate by polyfill). */
export const RUNTIME_CONTRACT = new Set([
  "AbortController",
  "AbortSignal",
  "Blob",
  "CompressionStream",
  "CryptoKey",
  "CustomEvent",
  "DOMException",
  "DecompressionStream",
  "Event",
  "EventTarget",
  "File",
  "FormData",
  "Headers",
  "MessageChannel",
  "MessagePort",
  "ReadableStream",
  "Request",
  "Response",
  "TextDecoder",
  "TextEncoder",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "WritableStream",
  "atob",
  "btoa",
  "clearInterval",
  "clearTimeout",
  "console",
  "crypto",
  "fetch",
  "performance",
  "queueMicrotask",
  "setInterval",
  "setTimeout",
  "structuredClone",
]);

const BROWSER_LIB =
  /[\\/]lib\.(dom|dom\.iterable|dom\.asynciterable|webworker|webworker\.importscripts|webworker\.iterable|scripthost)\.d\.ts$/;

/** Is `node` somewhere a type is expected, where references are erased? */
function inTypePosition(node) {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isTypeNode(at) && !ts.isExpressionWithTypeArguments(at)) return true;
    if (
      ts.isTypeAliasDeclaration(at) ||
      ts.isInterfaceDeclaration(at) ||
      ts.isTypeParameterDeclaration(at)
    )
      return true;
    if (ts.isHeritageClause(at))
      return at.token === ts.SyntaxKind.ImplementsKeyword;
    if (ts.isImportTypeNode(at)) return true;
    if (
      ts.isStatement(at) ||
      ts.isSourceFile(at) ||
      ts.isBlock(at) ||
      ts.isFunctionLike(at)
    )
      return false;
  }
  return false;
}

/** Parents whose `name` is a property name, never a reference. */
const NAMED_PROPERTY = [
  ts.isPropertyAccessExpression,
  ts.isPropertyAssignment,
  ts.isPropertyDeclaration,
  ts.isPropertySignature,
  ts.isMethodDeclaration,
  ts.isEnumMember,
];

/** Parents whose `name` declares a binding. */
const NAMED_DECLARATION = [
  ts.isVariableDeclaration,
  ts.isParameter,
  ts.isFunctionDeclaration,
  ts.isClassDeclaration,
  ts.isImportSpecifier,
  ts.isImportClause,
  ts.isNamespaceImport,
  ts.isExportSpecifier,
];

/** A name in a declaration or property-name slot, not a reference. */
function isDeclarationName(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if (ts.isLabeledStatement(parent)) return parent.label === node;
  return (
    parent.name === node &&
    [...NAMED_PROPERTY, ...NAMED_DECLARATION].some((is) => is(parent))
  );
}

/** `globalThis.localStorage` / `window.localStorage`: the property is the global. */
function globalPropertyName(node, checker) {
  const parent = node.parent;
  if (
    !ts.isPropertyAccessExpression(parent) ||
    parent.name !== node ||
    !ts.isIdentifier(parent.expression)
  )
    return null;
  const base = parent.expression.text;
  if (base !== "globalThis" && base !== "window" && base !== "self")
    return null;
  const symbol = checker.getSymbolAtLocation(node);
  return symbol ? node.text : null;
}

/**
 * Declared by a browser lib. `@types/node` also declares a few browser
 * globals Node only has behind a flag or with other semantics
 * (`localStorage`, `navigator`, `BroadcastChannel`); those still need a port,
 * so one browser declaration is enough.
 */
function browserOnly(symbol) {
  const declarations = symbol?.getDeclarations() ?? [];
  return declarations.some((d) => BROWSER_LIB.test(d.getSourceFile().fileName));
}

/**
 * Files held to the runtime contract, by package-relative path. The browser
 * host (`src/browser/**`) is the one place that touches browser globals, and a
 * worker entry (`*.worker.ts`) runs in a browser worker's own global scope;
 * tests may use whatever their environment offers.
 */
export function mustBePortable(path) {
  return (
    path.startsWith("src/") &&
    !path.startsWith("src/browser/") &&
    !/\.worker\.ts$/.test(path) &&
    !TEST_FILE.test(path)
  );
}

/**
 * @param {string} tsconfigPath
 * @param {(fileName: string) => boolean} inScope  which source files count
 * @returns {{ file: string, line: number, name: string }[]}
 */
export function findBrowserGlobals(tsconfigPath, inScope) {
  const config = ts.getParsedCommandLineOfConfigFile(
    tsconfigPath,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  if (!config) throw new Error(`cannot read ${tsconfigPath}`);
  const program = ts.createProgram(config.fileNames, config.options);
  const checker = program.getTypeChecker();
  const found = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !inScope(source.fileName)) continue;
    const visit = (node) => {
      if (ts.isIdentifier(node)) {
        const viaGlobal = globalPropertyName(node, checker);
        const name = viaGlobal ?? node.text;
        const candidate =
          viaGlobal !== null ||
          (!isDeclarationName(node) && !inTypePosition(node));
        if (candidate && !RUNTIME_CONTRACT.has(name)) {
          const symbol = checker.getSymbolAtLocation(node);
          if (browserOnly(symbol)) {
            const { line } = source.getLineAndCharacterOfPosition(
              node.getStart(source),
            );
            found.push({ file: source.fileName, line: line + 1, name });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}
