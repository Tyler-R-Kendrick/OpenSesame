/**
 * The analysis behind `egress-purposes.test.ts`: where a purpose is handed to
 * the egress port in a source file, and whether it is the catalog's own.
 *
 * A *site* is an object literal with a `purpose` property — named as an
 * identifier, a quoted string or a computed string — in a file that deals in
 * egress, and the meta argument of any call shaped like an egress request:
 * `x.fetch(url, init, meta)`, `x["fetch"](…)`, `x.decide(url, meta)`, or a
 * `fetch(url, init, meta)` destructured from an egress port. A meta that is a
 * variable is followed to the object it names, here or in the module it was
 * imported from; one that cannot be followed is a finding, not a pass.
 *
 * A site's purpose must be an identifier that traces — through local aliases
 * and `import { X as Y }` — to an import from a `capabilities/catalog-*`
 * module. A string literal is a retyped copy; anything computed is untraceable.
 */

import ts from "typescript";

export type Site = Readonly<{
  line: number;
  value: ts.Expression;
  capability: ts.Expression | undefined;
  source: ts.SourceFile;
}>;

export type Finding = Readonly<{ line: number; problem: string }>;

/** Reads another module's source, or null where it cannot be found. */
export type ModuleLoader = (
  from: string,
  specifier: string,
) => ts.SourceFile | null;

const CATALOG_IMPORT = /capabilities\/catalog-[a-z-]+(\.js)?$/;
const REQUEST_VERBS = new Set(["fetch", "decide"]);

export function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

/** `a`, `"a"` and `["a"]` all name the property `a`. */
function nameOf(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const inner = name.expression;
    return ts.isStringLiteralLike(inner) ? inner.text : `<${inner.getText()}>`;
  }
  return null;
}

function propertyNamed(
  literal: ts.ObjectLiteralExpression,
  wanted: string,
): ts.Expression | undefined {
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) && nameOf(property.name) === wanted)
      return property.initializer;
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === wanted
    )
      return property.name;
  }
  return undefined;
}

/** Whether the file deals in egress at all: an identifier or import says so. */
function dealsInEgress(source: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && /egress/i.test(node.text)) found = true;
    else if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /egress/i.test(node.moduleSpecifier.text)
    )
      found = true;
    else ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  )
    current = current.expression;
  return current;
}

/**
 * The initializer of the nearest `const name = …` visible from `from`: the
 * enclosing blocks outward, ending at the module's own top level.
 */
function constInitializer(
  source: ts.SourceFile,
  name: string,
  from?: ts.Node,
): ts.Expression | undefined {
  const chain: ts.Node[] = [];
  for (let node: ts.Node | undefined = from; node; node = node.parent)
    chain.push(node);
  chain.push(source);
  for (const scope of chain) {
    const statements =
      ts.isBlock(scope) || ts.isSourceFile(scope) ? scope.statements : [];
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText() === name && declaration.initializer)
          return unwrap(declaration.initializer);
      }
    }
  }
  return undefined;
}

type Import = Readonly<{ specifier: string; original: string }>;

function importOf(source: ts.SourceFile, local: string): Import | null {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    for (const element of bindings.elements) {
      if (element.name.text === local)
        return {
          specifier: statement.moduleSpecifier.text,
          original: (element.propertyName ?? element.name).text,
        };
    }
  }
  return null;
}

/** The object literal an identifier names, here or one import away. */
function objectNamed(
  source: ts.SourceFile,
  name: string,
  load: ModuleLoader,
  from?: ts.Node,
): ts.ObjectLiteralExpression | null {
  const local = constInitializer(source, name, from);
  if (local && ts.isObjectLiteralExpression(local)) return local;
  const imported = importOf(source, name);
  if (!imported) return null;
  const target = load(source.fileName, imported.specifier);
  const there = target && constInitializer(target, imported.original);
  return there && ts.isObjectLiteralExpression(there) ? there : null;
}

function verbOf(callee: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression)
  )
    return callee.argumentExpression.text;
  // A bare `fetch` is egress only when destructured from a port (below).
  if (ts.isIdentifier(callee) && callee.text === "fetch") return "fetch";
  return null;
}

/** The meta argument of an egress-shaped call, if the call is one. */
function metaArgument(call: ts.CallExpression): ts.Expression | undefined {
  const verb = verbOf(call.expression);
  if (verb === null || !REQUEST_VERBS.has(verb)) return undefined;
  // A bare `fetch(url, init)` is the platform's; only three arguments is egress.
  if (ts.isIdentifier(call.expression) && call.arguments.length < 3)
    return undefined;
  return call.arguments[verb === "decide" ? 1 : 2];
}

export function analyze(
  source: ts.SourceFile,
  load: ModuleLoader,
): Readonly<{ sites: Site[]; findings: Finding[] }> {
  const sites: Site[] = [];
  const findings: Finding[] = [];
  if (!dealsInEgress(source)) return { sites, findings };
  const seen = new Set<ts.Node>();
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const addSite = (
    literal: ts.ObjectLiteralExpression,
    handedOn: boolean,
  ): void => {
    if (seen.has(literal)) return;
    const value = propertyNamed(literal, "purpose");
    if (!value) return;
    // A descriptor's own egress entry (`class`, `purpose`, `automatic`) is the
    // declaration the sites are held to, not a request; and a purpose that is
    // neither handed to egress nor names a capability is some other word.
    if (propertyNamed(literal, "class") || propertyNamed(literal, "automatic"))
      return;
    if (!handedOn && !propertyNamed(literal, "capability")) return;
    seen.add(literal);
    sites.push({
      line: lineOf(literal),
      value,
      capability: propertyNamed(literal, "capability"),
      source,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) addSite(node, false);
    if (ts.isCallExpression(node)) {
      const meta = metaArgument(node);
      if (meta) checkMeta(meta);
    }
    ts.forEachChild(node, visit);
  };
  const checkMeta = (meta: ts.Expression): void => {
    const direct = unwrap(meta);
    if (ts.isObjectLiteralExpression(direct)) {
      addSite(direct, true);
      return;
    }
    const object = ts.isIdentifier(direct)
      ? objectNamed(source, direct.text, load, direct)
      : null;
    if (object === null) {
      findings.push({
        line: lineOf(meta),
        problem: `cannot trace the meta handed to egress (${meta.getText()}); build it as an object literal or a const the sweep can follow`,
      });
    } else if (object.getSourceFile() === source) addSite(object, true);
    // An imported meta is a site of the module that declares it, which the
    // sweep reads on its own.
  };
  visit(source);
  return { sites, findings };
}

/** The catalog export a site's purpose comes from, or why it is not one. */
export function catalogConstant(
  site: Site,
  load: ModuleLoader,
): Readonly<{ name: string }> | Readonly<{ problem: string }> {
  let current: ts.Expression = unwrap(site.value);
  // The module the expression being followed was written in.
  let source = site.source;
  for (let hops = 0; hops < 6; hops += 1) {
    if (ts.isStringLiteralLike(current))
      return { problem: `retypes the purpose ${current.getText()}` };
    if (ts.isPropertyAccessExpression(current)) {
      // `META.purpose`: follow the object, then its purpose.
      const base = unwrap(current.expression);
      const object = ts.isIdentifier(base)
        ? objectNamed(source, base.text, load, base)
        : null;
      const next = object && propertyNamed(object, current.name.text);
      if (!object || !next)
        return { problem: `cannot trace ${current.getText()} to a constant` };
      source = object.getSourceFile();
      current = unwrap(next);
      continue;
    }
    if (!ts.isIdentifier(current))
      return { problem: `computes its purpose (${current.getText()})` };
    const imported = importOf(source, current.text);
    if (imported !== null) {
      return CATALOG_IMPORT.test(imported.specifier)
        ? { name: imported.original }
        : {
            problem: `imports ${imported.original} from ${imported.specifier}`,
          };
    }
    const alias = constInitializer(source, current.text, current);
    if (!alias) return { problem: `cannot trace ${current.text}` };
    current = alias;
  }
  return { problem: "alias chain too long" };
}

/** The capability a site names, when it is a literal or a const of one. */
export function literalCapability(site: Site): string | null {
  let current = site.capability && unwrap(site.capability);
  for (let hops = 0; hops < 3 && current; hops += 1) {
    if (ts.isStringLiteralLike(current)) return current.text;
    if (!ts.isIdentifier(current)) return null;
    current = constInitializer(site.source, current.text, current);
  }
  return null;
}
