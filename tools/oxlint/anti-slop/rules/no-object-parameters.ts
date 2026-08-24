import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
	collectTypeEnvironment,
	lexicalTypeParameterBindings,
	parameterTypeAnnotation,
	resolveHazardousType,
	type TypeEnvironment,
} from "../shared/lexical-type-parameters.ts";

type ParameterOwner =
	| ESTree.ArrowFunctionExpression
	| ESTree.Function
	| ESTree.TSCallSignatureDeclaration
	| ESTree.TSConstructSignatureDeclaration
	| ESTree.TSConstructorType
	| ESTree.TSFunctionType
	| ESTree.TSMethodSignature;

function parameterName(parameter: ESTree.ParamPattern, sourceCode: SourceCode): string {
	if (parameter.type === "TSParameterProperty") {
		return parameterName(parameter.parameter, sourceCode);
	}
	if (parameter.type === "AssignmentPattern") {
		return parameterName(parameter.left, sourceCode);
	}
	if (parameter.type === "RestElement") {
		return parameterName(parameter.argument, sourceCode);
	}
	return parameter.type === "Identifier" ? parameter.name : sourceCode.getText(parameter);
}

/** Ban function inputs proven to use the broad `object` type. */
export const noObjectParametersRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow broad object function parameters while leaving opaque named contracts to TypeScript.",
		},
		messages: {
			objectParameter:
				"Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function.",
		},
	},
	createOnce(context) {
		let environment: TypeEnvironment | null = null;

		const checkParameters = (node: ParameterOwner) => {
			if (environment === null) return;
			const bindings = lexicalTypeParameterBindings(node);
			for (const parameter of node.params) {
				const annotation = parameterTypeAnnotation(parameter);
				if (annotation === null || annotation === undefined) continue;
				const resolution = resolveHazardousType(
					annotation.typeAnnotation,
					"object",
					environment,
					bindings,
				);
				if (resolution !== "hazard") continue;
				context.report({
					node: annotation.typeAnnotation,
					messageId: "objectParameter",
					data: { parameter: parameterName(parameter, context.sourceCode) },
				});
			}
		};

		return {
			Program(node) {
				environment = collectTypeEnvironment(node);
			},
			ArrowFunctionExpression: checkParameters,
			FunctionDeclaration: checkParameters,
			FunctionExpression: checkParameters,
			TSCallSignatureDeclaration: checkParameters,
			TSConstructSignatureDeclaration: checkParameters,
			TSConstructorType: checkParameters,
			TSDeclareFunction: checkParameters,
			TSEmptyBodyFunctionExpression: checkParameters,
			TSFunctionType: checkParameters,
			TSMethodSignature: checkParameters,
		};
	},
});
