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
  function visit(node) {
    if (executesSource(node)) unsupported = true;
    const specifier = actualSpecifier(node);
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      matches(specifier.text, name)
    )
      actual = true;
    if (specifier && !ts.isStringLiteralLike(specifier)) unsupported = true;
    const stringEvidence = sourceStringEvidence(node, name);
    if (stringEvidence === "unsupported") unsupported = true;
    if (stringEvidence === "fixture") fixture = true;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (actual) return "actual_import";
  if (fixture && !unsupported) return "literal_fixture";
  return "unresolved_diagnostic";
}

function sourceStringEvidence(node, name) {
  if (!ts.isStringLiteralLike(node) || !node.text.includes(name))
    return "ordinary";
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
