/**
 * Every egress purpose a capability names is one its catalog descriptor
 * declared, and is read from that declaration rather than retyped.
 *
 * `createEgressPort` classifies a request by matching its `purpose` against
 * the descriptor's `egress` entries by exact string. A module that spells the
 * purpose its own way is refused as `purpose-not-declared` on every request,
 * before any socket opens, and the person is told the service is unreachable
 * (`notifications.web-push` shipped like that: "push enrolment with the
 * configured Identity API" against a declared "the configured Identity API's
 * push enrolment"). This sweeps every non-test source file of the page and
 * the shared core for the places a purpose is handed to the egress port, so
 * the whole class fails here instead of in a person's browser.
 *
 * A site is an object literal with a `purpose` that also names a `capability`,
 * or that is passed straight to a `.fetch(...)` / `.decide(...)` call. Its
 * purpose must be an identifier that traces — through local aliases — to an
 * import from a `capabilities/catalog-*` module, whose exported constant is in
 * turn the text some descriptor declares. A string literal there is a retyped
 * copy and fails.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../../..");
const ROOTS = [
  join(repo, "apps/pages/src"),
  join(repo, "packages/app-core/src"),
];
const NOT_PRODUCTION =
  /(\.test\.|\.test-support\.|\.fixture\.|\.d\.ts$|\/__tests__\/|\/doubles\/|test-harness|test-context|runtime-test-kit)/;
const CATALOG_IMPORT = /capabilities\/catalog-[a-z-]+(\.js)?$/;

const catalogModules = import.meta.glob(
  "../../../../../packages/app-core/src/lib/capabilities/catalog-*.ts",
  { eager: true },
);

const declared = CAPABILITY_CATALOG.capabilities.flatMap((d) =>
  d.egress.map((e) => ({ capability: d.id, purpose: e.purpose })),
);

type Site = Readonly<{
  file: string;
  line: number;
  value: ts.Expression;
  capability: ts.Expression | undefined;
  source: ts.SourceFile;
}>;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) && !NOT_PRODUCTION.test(path) ? [path] : [];
  });
}

function propertyNamed(
  literal: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) && property.name.getText() === name)
      return property.initializer;
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === name
    )
      return property.name;
  }
  return undefined;
}

function handedToEgress(literal: ts.ObjectLiteralExpression): boolean {
  const call = literal.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(literal))
    return false;
  const callee = call.expression.getText();
  return /\.(fetch|decide)$/.test(callee);
}

function sitesIn(file: string): Site[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const value = propertyNamed(node, "purpose");
      const capability = propertyNamed(node, "capability");
      if (value && (capability || handedToEgress(node))) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push({
          file: relative(repo, file),
          line: line + 1,
          value,
          capability,
          source,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const SITES = ROOTS.flatMap(walk).flatMap(sitesIn);

function localInitializer(
  source: ts.SourceFile,
  name: string,
): ts.Expression | undefined {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText() === name) return declaration.initializer;
    }
  }
  return undefined;
}

function importedFrom(source: ts.SourceFile, name: string): string | null {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    for (const element of bindings.elements)
      if (element.name.text === name) return statement.moduleSpecifier.text;
  }
  return null;
}

/** The catalog export a purpose expression comes from, or why it does not. */
function catalogConstant(site: Site): string | { problem: string } {
  let current: ts.Expression = site.value;
  for (let hops = 0; hops < 5; hops += 1) {
    if (ts.isStringLiteralLike(current))
      return { problem: `retypes the purpose ${current.getText()}` };
    if (!ts.isIdentifier(current))
      return { problem: `computes its purpose (${current.getText()})` };
    const specifier = importedFrom(site.source, current.text);
    if (specifier !== null) {
      return CATALOG_IMPORT.test(specifier)
        ? current.text
        : { problem: `imports ${current.text} from ${specifier}` };
    }
    const alias = localInitializer(site.source, current.text);
    if (!alias) return { problem: `cannot trace ${current.text}` };
    current = alias;
  }
  return { problem: "alias chain too long" };
}

function literalCapability(site: Site): string | null {
  let current = site.capability;
  for (let hops = 0; hops < 3 && current; hops += 1) {
    if (ts.isStringLiteralLike(current)) return current.text;
    if (!ts.isIdentifier(current)) return null;
    current = localInitializer(site.source, current.text);
  }
  return null;
}

const catalogConstants = new Map<string, string>(
  Object.values(catalogModules).flatMap((module) =>
    Object.entries(module as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        entry[0].endsWith("_PURPOSE") && typeof entry[1] === "string",
    ),
  ),
);

describe("the sweep finds the places a purpose reaches the egress port", () => {
  it("includes the capabilities known to use one", () => {
    const files = new Set(SITES.map((site) => site.file));
    for (const known of [
      "apps/pages/src/modules/notifications.web-push/runtime.ts",
      "apps/pages/src/modules/sharing.live/carriers/allowed.ts",
      "packages/app-core/src/lib/tailnet-sync/plugin-daemon.ts",
    ])
      expect(files, known).toContain(known);
  });
});

describe("every purpose handed to egress is the catalog's own", () => {
  it.each(SITES.map((site) => [`${site.file}:${site.line}`, site] as const))(
    "%s",
    (_where, site) => {
      const constant = catalogConstant(site);
      expect(typeof constant === "string" ? "" : constant.problem).toBe("");
      const text = catalogConstants.get(String(constant));
      expect(
        text,
        `${String(constant)} is not exported by a catalog`,
      ).toBeDefined();
      const owners = declared
        .filter((entry) => entry.purpose === text)
        .map((entry) => entry.capability);
      expect(owners, `no descriptor declares ${String(constant)}`).not.toEqual(
        [],
      );
      const capability = literalCapability(site);
      if (capability !== null) expect(owners).toContain(capability);
    },
  );
});

describe("the catalog's declarations can be matched", () => {
  it("never leaves a purpose empty or shared inside one capability", () => {
    for (const descriptor of CAPABILITY_CATALOG.capabilities) {
      const purposes = descriptor.egress.map((e) => e.purpose);
      for (const purpose of purposes)
        expect(purpose.trim(), descriptor.id).not.toBe("");
      expect(new Set(purposes).size, descriptor.id).toBe(purposes.length);
    }
  });

  it("declares every exported purpose constant on some descriptor", () => {
    expect([...catalogConstants.keys()].sort()).toEqual([
      "LIVE_CARRIER_PURPOSE",
      "PLUGIN_DAEMON_PURPOSE",
      "WEB_PUSH_ENROLMENT_PURPOSE",
    ]);
    for (const [name, text] of catalogConstants)
      expect(
        declared.some((entry) => entry.purpose === text),
        name,
      ).toBe(true);
  });
});
