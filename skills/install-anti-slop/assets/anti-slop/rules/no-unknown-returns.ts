import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
	collectTypeEnvironment,
	lexicalTypeParameterBindings,
	parameterTypeAnnotation,
	resolveHazardousType,
	type TypeEnvironment,
	type TypeResolution,
} from "../shared/lexical-type-parameters.ts";

type FunctionWithReturnType =
	| ESTree.ArrowFunctionExpression
	| ESTree.Function
	| ESTree.TSCallSignatureDeclaration
	| ESTree.TSConstructSignatureDeclaration
	| ESTree.TSConstructorType
	| ESTree.TSFunctionType
	| ESTree.TSMethodSignature;

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function parameterIdentifier(parameter: ESTree.ParamPattern): string | null {
	if (parameter.type === "TSParameterProperty") {
		return parameterIdentifier(parameter.parameter);
	}
	if (parameter.type === "AssignmentPattern") {
		return parameterIdentifier(parameter.left);
	}
	if (parameter.type === "RestElement") {
		return parameterIdentifier(parameter.argument);
	}
	return parameter.type === "Identifier" ? parameter.name : null;
}

function nearestRuntimeFunction(node: ESTree.Node): RuntimeFunction | null {
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

function parameterTypeForIdentifier(name: string, owner: RuntimeFunction): ESTree.TSType | null {
	for (const parameter of owner.params) {
		if (parameterIdentifier(parameter) !== name) continue;
		return parameterTypeAnnotation(parameter)?.typeAnnotation ?? null;
	}
	return null;
}

function combineInferred(
	left: TypeResolution | null,
	right: TypeResolution | null,
): TypeResolution | null {
	if (left === "hazard" || right === "hazard") return "hazard";
	if (left === "unresolved" || right === "unresolved") return "unresolved";
	return left === "safe" || right === "safe" ? "safe" : null;
}

/** Ban explicit and directly inferable function contracts that expose unknown. */
export const noUnknownReturnsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow functions whose explicit or directly inferable return contract is proven to expose unknown.",
		},
		messages: {
			unknownReturn:
				"This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
		},
	},
	createOnce(context) {
		let environment: TypeEnvironment | null = null;

		const resolveExpression = (
			expression: ESTree.Expression,
			owner: RuntimeFunction,
		): TypeResolution | null => {
			if (environment === null) return null;
			if (expression.type === "TSAsExpression" || expression.type === "TSTypeAssertion") {
				return resolveHazardousType(
					expression.typeAnnotation,
					"unknown",
					environment,
					lexicalTypeParameterBindings(owner),
				);
			}
			if (expression.type === "TSSatisfiesExpression") {
				return resolveExpression(expression.expression, owner);
			}
			if (expression.type === "Identifier") {
				const type = parameterTypeForIdentifier(expression.name, owner);
				return type === null
					? null
					: resolveHazardousType(type, "unknown", environment, lexicalTypeParameterBindings(owner));
			}
			if (expression.type === "AwaitExpression") {
				return resolveExpression(expression.argument, owner);
			}
			if (expression.type === "ChainExpression" || expression.type === "TSNonNullExpression") {
				return resolveExpression(expression.expression, owner);
			}
			if (expression.type === "ConditionalExpression" || expression.type === "LogicalExpression") {
				return combineInferred(
					resolveExpression(
						expression.type === "ConditionalExpression" ? expression.consequent : expression.left,
						owner,
					),
					resolveExpression(
						expression.type === "ConditionalExpression" ? expression.alternate : expression.right,
						owner,
					),
				);
			}
			if (expression.type === "SequenceExpression") {
				const last = expression.expressions.at(-1);
				return last === undefined ? null : resolveExpression(last, owner);
			}
			if (expression.type === "AssignmentExpression") {
				return resolveExpression(expression.right, owner);
			}
			if (
				expression.type === "CallExpression" &&
				expression.callee.type === "MemberExpression" &&
				expression.callee.object.type === "Identifier" &&
				expression.callee.object.name === "Promise" &&
				expression.callee.property.type === "Identifier" &&
				expression.callee.property.name === "resolve"
			) {
				const value = expression.arguments[0];
				return value === undefined || value.type === "SpreadElement"
					? null
					: resolveExpression(value, owner);
			}
			return null;
		};

		const reportResolution = (node: ESTree.Node, resolution: TypeResolution | null) => {
			if (resolution !== "hazard") return;
			context.report({
				node,
				messageId: "unknownReturn",
			});
		};

		const checkReturnType = (node: FunctionWithReturnType) => {
			if (environment === null) return;
			const annotation = node.returnType;
			if (annotation === null || annotation === undefined) return;
			reportResolution(
				annotation.typeAnnotation,
				resolveHazardousType(
					annotation.typeAnnotation,
					"unknown",
					environment,
					lexicalTypeParameterBindings(node),
				),
			);
		};

		const checkArrow = (node: ESTree.ArrowFunctionExpression) => {
			checkReturnType(node);
			if (node.returnType !== null && node.returnType !== undefined) return;
			if (node.body.type === "BlockStatement") return;
			reportResolution(node.body, resolveExpression(node.body, node));
		};

		return {
			Program(node) {
				environment = collectTypeEnvironment(node);
			},
			ArrowFunctionExpression: checkArrow,
			FunctionDeclaration: checkReturnType,
			FunctionExpression: checkReturnType,
			ReturnStatement(node) {
				if (node.argument === null) return;
				const owner = nearestRuntimeFunction(node);
				if (owner === null || (owner.returnType !== null && owner.returnType !== undefined)) {
					return;
				}
				reportResolution(node.argument, resolveExpression(node.argument, owner));
			},
			TSCallSignatureDeclaration: checkReturnType,
			TSConstructSignatureDeclaration: checkReturnType,
			TSConstructorType: checkReturnType,
			TSDeclareFunction: checkReturnType,
			TSEmptyBodyFunctionExpression: checkReturnType,
			TSFunctionType: checkReturnType,
			TSMethodSignature: checkReturnType,
		};
	},
});
