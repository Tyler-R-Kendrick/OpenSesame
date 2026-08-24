import { defineRule } from "@oxlint/plugins";

import {
	classifyWideningTarget,
	createTypeEnvironment,
	isKnownEvidenceExpression,
	type TypeEnvironment,
	type WideningTarget,
} from "../shared/dictionary-types.ts";

import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

type FunctionExpression = ESTree.ArrowFunctionExpression | ESTree.Function;
type FunctionParameter = FunctionExpression["params"][number];

type FlowTarget = {
	readonly accumulator: "array" | "object" | null;
	readonly widening: WideningTarget;
};

function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSSatisfiesExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression"
	) {
		current = current.expression;
	}
	return current;
}

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

function variableDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
	if (variable.defs.length !== 1) return null;
	const [definition] = variable.defs;
	return definition?.type === "Variable" && definition.node.type === "VariableDeclarator"
		? definition.node
		: null;
}

function isStableConstVariable(variable: Variable, declarator: ESTree.VariableDeclarator): boolean {
	return (
		declarator.parent.type === "VariableDeclaration" &&
		declarator.parent.kind === "const" &&
		variable.references.every((reference) => reference.init || !reference.isWrite())
	);
}

function hasKnownEvidence(
	sourceCode: SourceCode,
	expression: ESTree.Expression,
	visitedVariables = new Set<Variable>(),
): boolean {
	if (isKnownEvidenceExpression(expression)) return true;
	const unwrapped = unwrapExpression(expression);
	if (unwrapped.type !== "Identifier") return false;
	const variable = resolveVariable(sourceCode, unwrapped);
	if (variable === null || visitedVariables.has(variable)) return false;
	const declarator = variableDeclarator(variable);
	if (
		declarator === null ||
		declarator.init === null ||
		!isStableConstVariable(variable, declarator)
	) {
		return false;
	}
	visitedVariables.add(variable);
	return hasKnownEvidence(sourceCode, declarator.init, visitedVariables);
}

function typeTarget(type: ESTree.TSType, environment: TypeEnvironment): FlowTarget | null {
	const widening = classifyWideningTarget(type, environment);
	if (widening !== null) {
		return {
			accumulator:
				widening.kind === "open dictionary" || widening.kind === "generic container"
					? "object"
					: null,
			widening,
		};
	}
	if (type.type !== "TSArrayType") return null;
	const elementTarget = classifyWideningTarget(type.elementType, environment);
	return elementTarget === null
		? null
		: { accumulator: "array", widening: { kind: "generic container" } };
}

function annotationTarget(
	annotation: ESTree.TSTypeAnnotation | null | undefined,
	environment: TypeEnvironment,
): FlowTarget | null {
	return annotation === null || annotation === undefined
		? null
		: typeTarget(annotation.typeAnnotation, environment);
}

function enclosingFunction(node: ESTree.Node): FunctionExpression | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (
			current.type === "ArrowFunctionExpression" ||
			current.type === "FunctionDeclaration" ||
			current.type === "FunctionExpression"
		) {
			return current;
		}
		current = current.parent;
	}
	return null;
}

function sourceKeyName(sourceCode: SourceCode, key: ESTree.PropertyKey): string {
	if (key.type === "Identifier" || key.type === "PrivateIdentifier") return key.name;
	if (key.type === "Literal") return String(key.value);
	return sourceCode.getText(key);
}

function functionName(sourceCode: SourceCode, owner: FunctionExpression | null): string {
	if (owner === null) return "anonymous function";
	if (owner.id !== null) return owner.id.name;
	const parent = owner.parent;
	if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier")
		return parent.id.name;
	if (parent.type === "MethodDefinition") return sourceKeyName(sourceCode, parent.key);
	return "anonymous function";
}

function isEmptyObjectExpression(expression: ESTree.Expression): boolean {
	const unwrapped = unwrapExpression(expression);
	return unwrapped.type === "ObjectExpression" && unwrapped.properties.length === 0;
}

function isEmptyArrayExpression(expression: ESTree.Expression): boolean {
	const unwrapped = unwrapExpression(expression);
	return unwrapped.type === "ArrayExpression" && unwrapped.elements.length === 0;
}

function isEmptyAccumulator(expression: ESTree.Expression, destination: FlowTarget): boolean {
	return (
		(destination.accumulator === "object" && isEmptyObjectExpression(expression)) ||
		(destination.accumulator === "array" && isEmptyArrayExpression(expression))
	);
}

function hasParentAssertion(node: ESTree.Node): boolean {
	return node.parent?.type === "TSAsExpression" || node.parent?.type === "TSTypeAssertion";
}

function parameterAnnotation(
	parameter: FunctionParameter,
): ESTree.TSTypeAnnotation | null | undefined {
	if (parameter.type === "TSParameterProperty") {
		return parameterAnnotation(parameter.parameter);
	}
	if (parameter.type === "AssignmentPattern") {
		return parameter.left.type === "Identifier" ? parameter.left.typeAnnotation : null;
	}
	return parameter.type === "Identifier" ? parameter.typeAnnotation : null;
}

function callableParameters(
	sourceCode: SourceCode,
	callee: ESTree.Expression,
): readonly FunctionParameter[] | null {
	const unwrapped = unwrapExpression(callee);
	if (
		unwrapped.type === "ArrowFunctionExpression" ||
		unwrapped.type === "FunctionExpression"
	) {
		return unwrapped.params;
	}
	if (unwrapped.type !== "Identifier") return null;
	const variable = resolveVariable(sourceCode, unwrapped);
	if (variable === null || variable.defs.length !== 1) return null;
	const definition = variable.defs[0];
	if (definition?.node.type === "FunctionDeclaration") {
		return definition.node.declare ? null : definition.node.params;
	}
	const declarator = variableDeclarator(variable);
	if (declarator === null || !isStableConstVariable(variable, declarator)) return null;
	if (declarator.parent.type === "VariableDeclaration" && declarator.parent.declare) return null;
	const annotation =
		declarator.id.type === "Identifier" ? declarator.id.typeAnnotation?.typeAnnotation : null;
	if (annotation?.type === "TSFunctionType") return annotation.params;
	if (declarator.init !== null) {
		const initializer = unwrapExpression(declarator.init);
		if (
			initializer.type === "ArrowFunctionExpression" ||
			initializer.type === "FunctionExpression"
		) {
			return initializer.params;
		}
	}
	return null;
}

function enclosingClassBody(node: ESTree.Node): ESTree.ClassBody | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (current.type === "ClassBody") return current;
		current = current.parent;
	}
	return null;
}

function thisPropertyAnnotation(
	sourceCode: SourceCode,
	left: ESTree.AssignmentTarget,
): ESTree.TSTypeAnnotation | null | undefined {
	if (
		left.type !== "MemberExpression" ||
		left.object.type !== "ThisExpression" ||
		left.optional ||
		left.property.type === "PrivateIdentifier" ||
		(left.computed && left.property.type !== "Literal")
	) {
		return null;
	}
	const propertyName = sourceKeyName(sourceCode, left.property);
	const classBody = enclosingClassBody(left);
	if (classBody === null) return null;
	for (const member of classBody.body) {
		if (
			(member.type === "PropertyDefinition" || member.type === "AccessorProperty") &&
			!member.static &&
			sourceKeyName(sourceCode, member.key) === propertyName
		) {
			return member.typeAnnotation;
		}
	}
	return null;
}

function promisedReturnTarget(
	owner: FunctionExpression | null,
	environment: TypeEnvironment,
): FlowTarget | null {
	const annotation = owner?.returnType?.typeAnnotation;
	if (
		owner?.async !== true ||
		annotation?.type !== "TSTypeReference" ||
		annotation.typeName.type !== "Identifier" ||
		annotation.typeName.name !== "Promise" ||
		annotation.typeArguments?.params.length !== 1
	) {
		return annotation === null || annotation === undefined
			? null
			: typeTarget(annotation, environment);
	}
	const promised = annotation.typeArguments.params[0];
	return promised === undefined ? null : typeTarget(promised, environment);
}

/** Detect sound syntactic cases where a known value is explicitly widened and loses evidence. */
export const noKnownValueWideningRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow syntactically established values from flowing into explicitly broad or anonymous target types that discard useful evidence.",
		},
		messages: {
			widening:
				"The explicit {{target}} type on {{subject}} discards known type evidence. Keep inference, validate with `satisfies`, or use a named owner contract.",
		},
	},
	createOnce(context) {
		let environment: TypeEnvironment | null = null;

		const reportFlow = (
			expression: ESTree.Expression,
			destination: FlowTarget | null,
			subject: string,
		) => {
			if (destination === null) return;
			if (isEmptyAccumulator(expression, destination)) return;
			if (!hasKnownEvidence(context.sourceCode, expression)) return;
			context.report({
				node: expression,
				messageId: "widening",
				data: { subject, target: destination.widening.kind },
			});
		};

		const targetFromAnnotation = (annotation: ESTree.TSTypeAnnotation | null | undefined) =>
			environment === null ? null : annotationTarget(annotation, environment);

		return {
			Program(node) {
				environment = createTypeEnvironment(node);
			},
			VariableDeclarator(node) {
				if (node.init === null || node.id.type !== "Identifier") return;
				reportFlow(
					node.init,
					targetFromAnnotation(node.id.typeAnnotation),
					`binding \`${node.id.name}\``,
				);
			},
			PropertyDefinition(node) {
				if (node.value === null) return;
				reportFlow(
					node.value,
					targetFromAnnotation(node.typeAnnotation),
					`property \`${sourceKeyName(context.sourceCode, node.key)}\``,
				);
			},
			AccessorProperty(node) {
				if (node.value === null) return;
				reportFlow(
					node.value,
					targetFromAnnotation(node.typeAnnotation),
					`property \`${sourceKeyName(context.sourceCode, node.key)}\``,
				);
			},
			AssignmentExpression(node) {
				if (node.operator !== "=") return;
				if (node.left.type === "Identifier") {
					const variable = resolveVariable(context.sourceCode, node.left);
					if (variable === null) return;
					const declarator = variableDeclarator(variable);
					if (declarator === null || declarator.id.type !== "Identifier") return;
					reportFlow(
						node.right,
						targetFromAnnotation(declarator.id.typeAnnotation),
						`binding \`${declarator.id.name}\``,
					);
					return;
				}
				const annotation = thisPropertyAnnotation(context.sourceCode, node.left);
				reportFlow(node.right, targetFromAnnotation(annotation), "class property");
			},
			AssignmentPattern(node) {
				if (node.left.type !== "Identifier") return;
				reportFlow(
					node.right,
					targetFromAnnotation(node.left.typeAnnotation),
					`default value of \`${node.left.name}\``,
				);
			},
			CallExpression(node) {
				if (node.callee.type === "Super") return;
				const parameters = callableParameters(context.sourceCode, node.callee);
				if (parameters === null) return;
				for (const [index, argument] of node.arguments.entries()) {
					if (argument.type === "SpreadElement") continue;
					const parameter = parameters[index];
					if (parameter === undefined || parameter.type === "RestElement") continue;
					reportFlow(
						argument,
						targetFromAnnotation(parameterAnnotation(parameter)),
						`argument ${index + 1}`,
					);
				}
			},
			ReturnStatement(node) {
				if (node.argument === null) return;
				const owner = enclosingFunction(node);
				reportFlow(
					node.argument,
					environment === null ? null : promisedReturnTarget(owner, environment),
					`return value of \`${functionName(context.sourceCode, owner)}\``,
				);
			},
			ArrowFunctionExpression(node) {
				if (node.body.type === "BlockStatement") return;
				reportFlow(
					node.body,
					environment === null ? null : promisedReturnTarget(node, environment),
					`return value of \`${functionName(context.sourceCode, node)}\``,
				);
			},
			TSAsExpression(node) {
				if (environment === null || hasParentAssertion(node)) return;
				reportFlow(
					node.expression,
					typeTarget(node.typeAnnotation, environment),
					"assertion",
				);
			},
			TSTypeAssertion(node) {
				if (environment === null || hasParentAssertion(node)) return;
				reportFlow(
					node.expression,
					typeTarget(node.typeAnnotation, environment),
					"assertion",
				);
			},
		};
	},
});
