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

function isExactErrorCause(
	parameter: ESTree.ParamPattern,
	annotation: ESTree.TSTypeAnnotation,
): boolean {
	return (
		parameter.type === "Identifier" &&
		parameter.name === "cause" &&
		annotation.typeAnnotation.type === "TSUnknownKeyword"
	);
}

/** Disallow unknown inputs except an exact `cause: unknown` error boundary. */
export const noUnknownParametersRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow unknown function parameters except exact error-cause enrichment; decode input at its I/O boundary.",
		},
		messages: {
			unknownParameter:
				"Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
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
				if (isExactErrorCause(parameter, annotation)) continue;
				const resolution = resolveHazardousType(
					annotation.typeAnnotation,
					"unknown",
					environment,
					bindings,
				);
				if (resolution !== "hazard") continue;
				context.report({
					node: annotation.typeAnnotation,
					messageId: "unknownParameter",
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
