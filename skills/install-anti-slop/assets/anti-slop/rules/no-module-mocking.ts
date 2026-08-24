import { defineRule } from "@oxlint/plugins";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

type MockValue = "jest" | "jest-namespace" | "mock-function" | "vi" | "vitest-namespace";

const maxAliasDepth = 12;
const knownProperties: readonly string[] = [
  "doMock",
  "jest",
  "mock",
  "setMock",
  "unstable_mockModule",
  "vi",
];

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (
    current.type === "ChainExpression" ||
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
}

function propertyMatches(
  property: ESTree.PropertyKey,
  computed: boolean,
  expected: string,
): boolean {
  return computed
    ? property.type === "Literal" && property.value === expected
    : property.type === "Identifier" && property.name === expected;
}

function knownPropertyName(property: ESTree.PropertyKey, computed: boolean): string | null {
  for (const name of knownProperties) {
    if (propertyMatches(property, computed, name)) return name;
  }
  return null;
}

function importedName(node: ESTree.ImportSpecifier): string | null {
  return node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
}

function importedMockValue(variable: Variable): MockValue | null {
  if (variable.defs.length !== 1) return null;
  const [definition] = variable.defs;
  if (
    definition?.type !== "ImportBinding" ||
    definition.parent?.type !== "ImportDeclaration"
  ) {
    return null;
  }

  const source = definition.parent.source.value;
  if (definition.node.type === "ImportNamespaceSpecifier") {
    if (source === "vitest") return "vitest-namespace";
    if (source === "@jest/globals") return "jest-namespace";
    return null;
  }
  if (definition.node.type !== "ImportSpecifier") return null;

  const name = importedName(definition.node);
  if (source === "vitest" && name === "vi") return "vi";
  if (source === "@jest/globals" && name === "jest") return "jest";
  return null;
}

function stableDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
  if (variable.defs.length !== 1) return null;
  const [definition] = variable.defs;
  if (
    definition?.type !== "Variable" ||
    definition.node.type !== "VariableDeclarator" ||
    definition.node.parent.type !== "VariableDeclaration" ||
    (definition.node.parent.kind !== "const" && definition.node.parent.kind !== "let") ||
    variable.references.some((reference) => reference.isWrite() && !reference.init)
  ) {
    return null;
  }
  return definition.node;
}

function bindingPath(
  pattern: ESTree.BindingPattern,
  variableName: string,
  depth = 0,
): readonly string[] | null {
  if (depth > maxAliasDepth) return null;
  if (pattern.type === "Identifier") return pattern.name === variableName ? [] : null;
  if (pattern.type === "AssignmentPattern") {
    return bindingPath(pattern.left, variableName, depth + 1);
  }
  if (pattern.type !== "ObjectPattern") return null;

  for (const property of pattern.properties) {
    if (property.type === "RestElement") continue;
    const childPath = bindingPath(property.value, variableName, depth + 1);
    if (childPath === null) continue;
    const propertyName = knownPropertyName(property.key, property.computed);
    return propertyName === null ? null : [propertyName, ...childPath];
  }
  return null;
}

function memberValue(owner: MockValue, property: string): MockValue | null {
  if (owner === "vitest-namespace" && property === "vi") return "vi";
  if (owner === "jest-namespace" && property === "jest") return "jest";
  if (
    owner === "vi" &&
    (property === "doMock" || property === "mock" || property === "unstable_mockModule")
  ) {
    return "mock-function";
  }
  if (
    owner === "jest" &&
    (property === "doMock" ||
      property === "mock" ||
      property === "setMock" ||
      property === "unstable_mockModule")
  ) {
    return "mock-function";
  }
  return null;
}

function valueAtPath(owner: MockValue, path: readonly string[]): MockValue | null {
  let current: MockValue | null = owner;
  for (const property of path) {
    if (current === null) return null;
    current = memberValue(current, property);
  }
  return current;
}

function wrapperCall(
  expression: ESTree.ArrowFunctionExpression | ESTree.Function,
): ESTree.CallExpression | null {
  const body = expression.body;
  if (body === null) return null;
  if (body.type !== "BlockStatement") return body.type === "CallExpression" ? body : null;
  if (body.body.length !== 1) return null;
  const [statement] = body.body;
  if (statement?.type === "ReturnStatement") {
    return statement.argument?.type === "CallExpression" ? statement.argument : null;
  }
  return statement?.type === "ExpressionStatement" && statement.expression.type === "CallExpression"
    ? statement.expression
    : null;
}

function resolveMockValue(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  visitedVariables: ReadonlySet<Variable>,
  depth: number,
): MockValue | null {
  if (depth > maxAliasDepth) return null;
  const unwrapped = unwrapExpression(expression);

  if (unwrapped.type === "ImportExpression" && unwrapped.source.type === "Literal") {
    if (unwrapped.source.value === "vitest") return "vitest-namespace";
    if (unwrapped.source.value === "@jest/globals") return "jest-namespace";
    return null;
  }

  if (unwrapped.type === "AwaitExpression") {
    return resolveMockValue(sourceCode, unwrapped.argument, visitedVariables, depth + 1);
  }

  if (unwrapped.type === "MemberExpression") {
    const property = knownPropertyName(unwrapped.property, unwrapped.computed);
    if (property === null) return null;
    const owner = resolveMockValue(sourceCode, unwrapped.object, visitedVariables, depth + 1);
    return owner === null ? null : memberValue(owner, property);
  }

  if (unwrapped.type === "ArrowFunctionExpression" || unwrapped.type === "FunctionExpression") {
    const call = wrapperCall(unwrapped);
    if (
      call === null ||
      call.callee.type === "Super" ||
      call.callee.type === "V8IntrinsicExpression"
    ) {
      return null;
    }
    return resolveMockValue(sourceCode, call.callee, visitedVariables, depth + 1) ===
      "mock-function"
      ? "mock-function"
      : null;
  }

  if (unwrapped.type !== "Identifier") return null;
  const variable = resolveVariable(sourceCode, unwrapped);
  if (
    (unwrapped.name === "vi" || unwrapped.name === "jest") &&
    (sourceCode.isGlobalReference(unwrapped) || variable === null || variable.defs.length === 0)
  ) {
    return unwrapped.name;
  }

  if (variable === null || visitedVariables.has(variable)) return null;
  const imported = importedMockValue(variable);
  if (imported !== null) return imported;

  const nextVisited = new Set([...visitedVariables, variable]);
  const declarator = stableDeclarator(variable);
  if (declarator !== null && declarator.init !== null) {
    const owner = resolveMockValue(sourceCode, declarator.init, nextVisited, depth + 1);
    if (owner === null) return null;
    const path = bindingPath(declarator.id, variable.name);
    return path === null ? null : valueAtPath(owner, path);
  }

  if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return null;
  if (variable.defs.length !== 1) return null;
  const [definition] = variable.defs;
  if (definition?.type !== "FunctionName" || definition.node.type !== "FunctionDeclaration") {
    return null;
  }
  const call = wrapperCall(definition.node);
  if (call === null || call.callee.type === "Super" || call.callee.type === "V8IntrinsicExpression") {
    return null;
  }
  return resolveMockValue(sourceCode, call.callee, nextVisited, depth + 1) === "mock-function"
    ? "mock-function"
    : null;
}

/** Ban test framework module mocking in favor of real dependency seams. */
export const noModuleMockingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Vitest and Jest module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        if (resolveMockValue(context.sourceCode, node.callee, new Set(), 0) === "mock-function") {
          context.report({ node, messageId: "moduleMock" });
        }
      },
    };
  },
});
