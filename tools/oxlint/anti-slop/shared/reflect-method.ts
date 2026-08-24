import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

type ReflectMethod = "apply" | "get";
type ReflectValue = ReflectMethod | "reflect";

const maxAliasDepth = 12;

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
  expected: ReflectMethod,
): boolean {
  return computed
    ? property.type === "Literal" && property.value === expected
    : property.type === "Identifier" && property.name === expected;
}

function reflectPropertyName(
  property: ESTree.PropertyKey,
  computed: boolean,
): ReflectMethod | null {
  if (propertyMatches(property, computed, "apply")) return "apply";
  return propertyMatches(property, computed, "get") ? "get" : null;
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
): readonly ReflectMethod[] | null {
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
    const propertyName = reflectPropertyName(property.key, property.computed);
    return propertyName === null ? null : [propertyName, ...childPath];
  }
  return null;
}

function valueAtPath(owner: ReflectValue, path: readonly ReflectMethod[]): ReflectValue | null {
  let current: ReflectValue | null = owner;
  for (const property of path) {
    if (current !== "reflect") return null;
    current = property;
  }
  return current;
}

function resolveReflectValue(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  visitedVariables: ReadonlySet<Variable>,
  depth: number,
): ReflectValue | null {
  if (depth > maxAliasDepth) return null;
  const unwrapped = unwrapExpression(expression);

  if (unwrapped.type === "MemberExpression") {
    const property = reflectPropertyName(unwrapped.property, unwrapped.computed);
    if (property === null) return null;
    return resolveReflectValue(sourceCode, unwrapped.object, visitedVariables, depth + 1) ===
      "reflect"
      ? property
      : null;
  }

  if (unwrapped.type !== "Identifier") return null;
  const variable = resolveVariable(sourceCode, unwrapped);
  if (
    unwrapped.name === "Reflect" &&
    (sourceCode.isGlobalReference(unwrapped) || variable === null || variable.defs.length === 0)
  ) {
    return "reflect";
  }
  if (variable === null || visitedVariables.has(variable)) return null;

  const declarator = stableDeclarator(variable);
  if (declarator === null || declarator.init === null) return null;
  const owner = resolveReflectValue(
    sourceCode,
    declarator.init,
    new Set([...visitedVariables, variable]),
    depth + 1,
  );
  if (owner === null) return null;
  const path = bindingPath(declarator.id, variable.name);
  return path === null ? null : valueAtPath(owner, path);
}

/** Reports whether a call target resolves to one method on the global Reflect object. */
export function isGlobalReflectMethodCall(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
  methodName: ReflectMethod,
): boolean {
  return resolveReflectValue(sourceCode, callee, new Set(), 0) === methodName;
}
