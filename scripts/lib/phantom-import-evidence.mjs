import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { z } from "zod";

function matches(specifier, name) {
  return specifier === name || specifier.startsWith(`${name}/`);
}

function importCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const expression = node.expression;
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(expression)) return expression.text === "require";
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    expression.name.text === "resolve"
  );
}

function actualSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (importCall(node)) return node.arguments[0];
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    return node.moduleReference.expression;
  }
  return undefined;
}

function parseSource(path, source) {
  const parsed = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  if (parsed.parseDiagnostics.length !== 0)
    throw new Error("Unsupported source syntax");
  return parsed;
}

function hasLiteralImport(source, name) {
  const parsed = parseSource("fixture.tsx", source);
  let found = false;
  function visit(node) {
    const specifier = actualSpecifier(node);
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      matches(specifier.text, name)
    )
      found = true;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return found;
}

function classifySource(parsed, name) {
  let actual = false;
  let fixture = false;
  let unsupported = false;
  let diagnostic = false;
  const builtins = unshadowedDiagnosticBuiltins(parsed);
  function visit(node) {
    if (executesSource(node) && !constantGlobalGetter(node, builtins))
      unsupported = true;
    const specifier = actualSpecifier(node);
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      matches(specifier.text, name)
    )
      actual = true;
    if (specifier && !ts.isStringLiteralLike(specifier)) unsupported = true;
    const stringEvidence = sourceStringEvidence(node, name, builtins);
    if (stringEvidence === "unsupported") unsupported = true;
    if (stringEvidence === "fixture") fixture = true;
    if (stringEvidence === "diagnostic") diagnostic = true;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (actual) return "actual_import";
  if (diagnostic && !unsupported) return "literal_diagnostic";
  if (fixture && !unsupported) return "literal_fixture";
  return "unresolved_diagnostic";
}

const reflectDiagnostic =
  "tsyringe requires a reflect polyfill. Please add 'import \"reflect-metadata\"' to the top of your entry point.";

function unshadowedDiagnosticBuiltins(parsed) {
  let safe = true;
  function visit(node) {
    if (
      ts.isIdentifier(node) &&
      ["Error", "Symbol", "Function", "Object"].includes(node.text)
    ) {
      const ordinaryUse = ordinaryBuiltinUse(node);
      if (!ordinaryUse || isAssignedBuiltin(node)) safe = false;
    }
    if (mutatesGlobalBuiltin(node)) safe = false;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return safe;
}

function prototypeRead(node, parent) {
  return (
    node.text === "Function" &&
    ts.isCallExpression(parent) &&
    parent.arguments.length === 1 &&
    propertyCall(parent.expression, "Object", "getPrototypeOf")
  );
}

function propertyCall(expression, object, name) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === object &&
    expression.name.text === name
  );
}

function ordinaryBuiltinUse(node) {
  const parent = node.parent;
  if (
    (ts.isNewExpression(parent) || ts.isCallExpression(parent)) &&
    parent.expression === node
  )
    return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
    return true;
  if (ts.isTypeOfExpression(parent)) return true;
  if (
    node.text === "Error" &&
    ts.isExpressionWithTypeArguments(parent) &&
    parent.expression === node
  )
    return true;
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    parent.right === node
  )
    return true;
  return prototypeRead(node, parent);
}

function mutationTarget(node) {
  if (ts.isBinaryExpression(node)) {
    if (
      node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
      node.operatorToken.kind > ts.SyntaxKind.LastAssignment
    )
      return undefined;
    return node.left;
  }
  if (
    ts.isDeleteExpression(node) ||
    ts.isPrefixUnaryExpression(node) ||
    ts.isPostfixUnaryExpression(node)
  )
    return node.expression ?? node.operand;
  return undefined;
}

function mutatesGlobalBuiltin(node) {
  let target = mutationTarget(node);
  if (!target) return false;
  const names = [];
  let unknown = false;
  while (
    ts.isPropertyAccessExpression(target) ||
    ts.isElementAccessExpression(target)
  ) {
    if (ts.isPropertyAccessExpression(target)) names.unshift(target.name.text);
    else if (
      target.argumentExpression &&
      ts.isStringLiteralLike(target.argumentExpression)
    )
      names.unshift(target.argumentExpression.text);
    else unknown = true;
    target = target.expression;
  }
  return (
    ts.isIdentifier(target) &&
    ["globalThis", "window", "self", "global"].includes(target.text) &&
    (unknown || ["Error", "Symbol", "Function", "Object"].includes(names[0]))
  );
}

function isAssignedBuiltin(node) {
  let target = node;
  while (
    ts.isPropertyAccessExpression(target.parent) &&
    target.parent.expression === target
  )
    target = target.parent;
  const parent = target.parent;
  return (
    (ts.isBinaryExpression(parent) &&
      parent.left === target &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ts.isPrefixUnaryExpression(parent) ||
    ts.isPostfixUnaryExpression(parent) ||
    ts.isDeleteExpression(parent)
  );
}

function thrownErrorArgument(node) {
  const parent = node.parent;
  return (
    ts.isNewExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === "Error" &&
    parent.arguments?.length === 1 &&
    parent.arguments[0] === node &&
    ts.isThrowStatement(parent.parent) &&
    parent.parent.expression === parent
  );
}

function registrySymbolArgument(node) {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === node &&
    propertyCall(parent.expression, "Symbol", "for")
  );
}

function reflectStringEvidence(node, name, builtins) {
  if (name !== "reflect-metadata") return undefined;
  if (node.text === reflectDiagnostic)
    return builtins && thrownErrorArgument(node) ? "diagnostic" : "unsupported";
  if (
    node.text === "@reflect-metadata:registry" &&
    builtins &&
    registrySymbolArgument(node)
  )
    return "ordinary";
  return undefined;
}

function sourceStringEvidence(node, name, builtins) {
  if (!ts.isStringLiteralLike(node) || !node.text.includes(name))
    return "ordinary";
  const reflectEvidence = reflectStringEvidence(node, name, builtins);
  if (reflectEvidence !== undefined) return reflectEvidence;
  const callArgument =
    ts.isCallExpression(node.parent) && node.parent.arguments.includes(node);
  if (callArgument) return importCall(node.parent) ? "ordinary" : "unsupported";
  if (node === actualSpecifier(node.parent)) return "ordinary";
  try {
    return hasLiteralImport(node.text, name) ? "fixture" : "ordinary";
  } catch {
    // Ordinary strings are not evidence of a scanner fixture match.
    return "ordinary";
  }
}

function constantGlobalGetter(node, builtins) {
  return (
    builtins &&
    (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Function" &&
    node.arguments?.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    node.arguments[0].text === "return this;"
  );
}

function executesSource(node) {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false;
  const expression = node.expression;
  const codeExecutors = new Set([
    "eval",
    "Function",
    "Script",
    "compileFunction",
    "runInContext",
    "runInNewContext",
    "runInThisContext",
  ]);
  if (ts.isIdentifier(expression)) return codeExecutors.has(expression.text);
  return (
    ts.isPropertyAccessExpression(expression) &&
    codeExecutors.has(expression.name.text)
  );
}

/** Parse source bytes without loading or executing their modules. */
export function inspectPhantomImport(project, name, file) {
  try {
    const root = realpathSync(project);
    const path = realpathSync(resolve(root, file));
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("Source escapes project");
    if (!statSync(path).isFile() || statSync(path).size > 1_048_576)
      throw new Error("Invalid source file");
    return classifySource(parseSource(path, readFileSync(path, "utf8")), name);
  } catch {
    return "unresolved_diagnostic";
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const inputs = z
    .array(z.object({ name: z.string(), file: z.string() }))
    .parse(JSON.parse(readFileSync(0, "utf8")));
  const project = z.string().parse(process.argv[2]);
  process.stdout.write(
    `${JSON.stringify(inputs.map((row) => inspectPhantomImport(project, row.name, row.file)))}\n`,
  );
}
