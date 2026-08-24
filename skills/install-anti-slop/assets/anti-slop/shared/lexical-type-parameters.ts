import type { ESTree } from "@oxlint/plugins";

export type HazardousType = "object" | "unknown";
export type TypeResolution = "hazard" | "safe" | "unresolved";

export type TypeEnvironment = Readonly<{
	aliases: ReadonlyMap<string, ESTree.TSTypeAliasDeclaration>;
	declaredTypes: ReadonlySet<string>;
	importedTypes: ReadonlySet<string>;
}>;

export type TypeBindings = ReadonlyMap<string, ESTree.TSType | null>;

const MAX_RESOLUTION_DEPTH = 32;

const knownGlobalTypes = new Set([
	"AbortController",
	"AbortSignal",
	"Array",
	"ArrayBuffer",
	"Awaited",
	"BigInt",
	"Boolean",
	"Capitalize",
	"ConstructorParameters",
	"DataView",
	"Date",
	"Error",
	"ErrorOptions",
	"Exclude",
	"Extract",
	"Float32Array",
	"Float64Array",
	"Function",
	"Headers",
	"InstanceType",
	"Int16Array",
	"Int32Array",
	"Int8Array",
	"Lowercase",
	"Map",
	"NonNullable",
	"Number",
	"Object",
	"Omit",
	"OmitThisParameter",
	"Parameters",
	"Partial",
	"Pick",
	"Promise",
	"PromiseLike",
	"Readonly",
	"ReadonlyArray",
	"ReadonlyMap",
	"ReadonlySet",
	"Record",
	"RegExp",
	"Request",
	"Required",
	"Response",
	"ReturnType",
	"Set",
	"SharedArrayBuffer",
	"String",
	"Symbol",
	"ThisParameterType",
	"ThisType",
	"Uint16Array",
	"Uint32Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Uncapitalize",
	"Uppercase",
	"URL",
	"URLSearchParams",
	"WeakMap",
	"WeakSet",
]);

export function parameterTypeAnnotation(
	parameter: ESTree.ParamPattern,
): ESTree.TSTypeAnnotation | null | undefined {
	if (parameter.type === "TSParameterProperty") {
		return parameterTypeAnnotation(parameter.parameter);
	}
	if (parameter.type === "RestElement") {
		return parameter.typeAnnotation ?? parameterTypeAnnotation(parameter.argument);
	}
	if (parameter.type === "AssignmentPattern") {
		return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
	}
	return parameter.typeAnnotation;
}

function exportedDeclaration(statement: ESTree.Program["body"][number]): ESTree.Declaration | null {
	if (statement.type === "ExportNamedDeclaration") return statement.declaration;
	if (
		statement.type === "TSTypeAliasDeclaration" ||
		statement.type === "TSInterfaceDeclaration" ||
		statement.type === "TSEnumDeclaration" ||
		statement.type === "ClassDeclaration"
	) {
		return statement;
	}
	return null;
}

/** Collect module-level aliases and names that a syntax-only rule can resolve. */
export function collectTypeEnvironment(program: ESTree.Program): TypeEnvironment {
	const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>();
	const declaredTypes = new Set<string>();
	const importedTypes = new Set<string>();

	for (const statement of program.body) {
		if (statement.type === "ImportDeclaration") {
			for (const specifier of statement.specifiers) importedTypes.add(specifier.local.name);
			continue;
		}
		const declaration = exportedDeclaration(statement);
		if (declaration?.type === "TSTypeAliasDeclaration") {
			aliases.set(declaration.id.name, declaration);
			continue;
		}
		if (
			declaration?.type === "TSInterfaceDeclaration" ||
			declaration?.type === "TSEnumDeclaration" ||
			declaration?.type === "ClassDeclaration"
		) {
			if (declaration.id !== null) declaredTypes.add(declaration.id.name);
		}
	}

	return { aliases, declaredTypes, importedTypes };
}

export function typeParameterBindings(
	parameters: ESTree.TSTypeParameterDeclaration | null | undefined,
): TypeBindings {
	const bindings = new Map<string, ESTree.TSType | null>();
	for (const parameter of parameters?.params ?? []) {
		bindings.set(parameter.name.name, parameter.default);
	}
	return bindings;
}

function collectInferTypeParameters(
	type: ESTree.TSType,
	bindings: Map<string, ESTree.TSType | null>,
): void {
	if (type.type === "TSInferType") {
		bindings.set(type.typeParameter.name.name, type.typeParameter.default);
		return;
	}
	if (
		type.type === "TSParenthesizedType" ||
		type.type === "TSArrayType" ||
		type.type === "TSJSDocNullableType" ||
		type.type === "TSJSDocNonNullableType"
	) {
		collectInferTypeParameters(
			type.type === "TSArrayType" ? type.elementType : type.typeAnnotation,
			bindings,
		);
		return;
	}
	if (type.type === "TSUnionType" || type.type === "TSIntersectionType") {
		for (const member of type.types) collectInferTypeParameters(member, bindings);
		return;
	}
	if (type.type === "TSConditionalType") {
		collectInferTypeParameters(type.checkType, bindings);
		collectInferTypeParameters(type.extendsType, bindings);
		collectInferTypeParameters(type.trueType, bindings);
		collectInferTypeParameters(type.falseType, bindings);
		return;
	}
	if (type.type === "TSIndexedAccessType") {
		collectInferTypeParameters(type.objectType, bindings);
		collectInferTypeParameters(type.indexType, bindings);
		return;
	}
	if (type.type === "TSTupleType") {
		for (const element of type.elementTypes) {
			if (element.type === "TSNamedTupleMember") {
				const nested = element.elementType;
				collectInferTypeParameters(
					nested.type === "TSOptionalType" || nested.type === "TSRestType"
						? nested.typeAnnotation
						: nested,
					bindings,
				);
			} else {
				collectInferTypeParameters(
					element.type === "TSOptionalType" || element.type === "TSRestType"
						? element.typeAnnotation
						: element,
					bindings,
				);
			}
		}
		return;
	}
	if (type.type === "TSTypeReference" || type.type === "TSImportType") {
		for (const argument of type.typeArguments?.params ?? []) {
			collectInferTypeParameters(argument, bindings);
		}
		return;
	}
	if (type.type === "TSTypeQuery") {
		for (const argument of type.typeArguments?.params ?? []) {
			collectInferTypeParameters(argument, bindings);
		}
		return;
	}
	if (type.type === "TSTemplateLiteralType") {
		for (const nested of type.types) collectInferTypeParameters(nested, bindings);
	}
}

/** Collect generic, mapped, and conditional infer binders visible from a node. */
export function lexicalTypeParameterBindings(node: ESTree.Node): TypeBindings {
	const bindings = new Map<string, ESTree.TSType | null>();
	let descendant: ESTree.Node = node;
	let current: ESTree.Node | null = node;
	while (current !== null && current.type !== "Program") {
		if ("typeParameters" in current) {
			for (const parameter of current.typeParameters?.params ?? []) {
				if (!bindings.has(parameter.name.name)) {
					bindings.set(parameter.name.name, parameter.default);
				}
			}
		}
		if (
			current.type === "TSMappedType" &&
			(descendant === current.nameType || descendant === current.typeAnnotation) &&
			!bindings.has(current.key.name)
		) {
			bindings.set(current.key.name, null);
		}
		if (current.type === "TSConditionalType" && descendant === current.trueType) {
			const inferred = new Map<string, ESTree.TSType | null>();
			collectInferTypeParameters(current.extendsType, inferred);
			for (const [name, value] of inferred) {
				if (!bindings.has(name)) bindings.set(name, value);
			}
		}
		descendant = current;
		current = current.parent;
	}
	return bindings;
}

function combineUnion(resolutions: readonly TypeResolution[]): TypeResolution {
	if (resolutions.includes("hazard")) return "hazard";
	return resolutions.includes("unresolved") ? "unresolved" : "safe";
}

function combineIntersection(resolutions: readonly TypeResolution[]): TypeResolution {
	if (resolutions.includes("safe")) return "safe";
	if (resolutions.includes("unresolved")) return "unresolved";
	return resolutions.length === 0 ? "safe" : "hazard";
}

function resolveTupleElement(
	element: ESTree.TSTupleElement,
	hazard: HazardousType,
	environment: TypeEnvironment,
	bindings: TypeBindings,
	visitedAliases: ReadonlySet<string>,
	depth: number,
): TypeResolution {
	if (element.type === "TSNamedTupleMember") {
		return resolveTupleElement(
			element.elementType,
			hazard,
			environment,
			bindings,
			visitedAliases,
			depth,
		);
	}
	return resolveType(
		element.type === "TSOptionalType" || element.type === "TSRestType"
			? element.typeAnnotation
			: element,
		hazard,
		environment,
		bindings,
		visitedAliases,
		depth,
	);
}

function resolveReference(
	type: ESTree.TSTypeReference,
	hazard: HazardousType,
	environment: TypeEnvironment,
	bindings: TypeBindings,
	visitedAliases: ReadonlySet<string>,
	depth: number,
): TypeResolution {
	const argumentResolution = combineUnion(
		(type.typeArguments?.params ?? []).map((argument) =>
			resolveType(argument, hazard, environment, bindings, visitedAliases, depth + 1),
		),
	);
	if (argumentResolution !== "safe") return argumentResolution;
	if (type.typeName.type !== "Identifier") return "safe";

	const name = type.typeName.name;
	if (bindings.has(name)) {
		const binding = bindings.get(name);
		return binding === null || binding === undefined
			? "safe"
			: resolveType(binding, hazard, environment, bindings, visitedAliases, depth + 1);
	}

	const alias = environment.aliases.get(name);
	if (alias !== undefined) {
		if (visitedAliases.has(name)) return "unresolved";
		const parameters = alias.typeParameters?.params ?? [];
		const arguments_ = type.typeArguments?.params ?? [];
		if (arguments_.length > parameters.length) return "unresolved";
		const aliasBindings = new Map(bindings);
		for (const [index, parameter] of parameters.entries()) {
			const argument = arguments_[index] ?? parameter.default;
			if (argument === null || argument === undefined) return "unresolved";
			aliasBindings.set(parameter.name.name, argument);
		}
		const nextVisited = new Set(visitedAliases);
		nextVisited.add(name);
		return resolveType(
			alias.typeAnnotation,
			hazard,
			environment,
			aliasBindings,
			nextVisited,
			depth + 1,
		);
	}

	// Imported named types are owner contracts checked by TypeScript. This
	// syntax-only rule still inspects their explicit type arguments above.
	if (environment.importedTypes.has(name)) return "safe";
	return environment.declaredTypes.has(name) || knownGlobalTypes.has(name) ? "safe" : "unresolved";
}

function resolveType(
	type: ESTree.TSType,
	hazard: HazardousType,
	environment: TypeEnvironment,
	bindings: TypeBindings,
	visitedAliases: ReadonlySet<string>,
	depth: number,
): TypeResolution {
	if (depth > MAX_RESOLUTION_DEPTH) return "unresolved";
	if (
		(hazard === "unknown" &&
			(type.type === "TSUnknownKeyword" || type.type === "TSJSDocUnknownType")) ||
		(hazard === "object" && type.type === "TSObjectKeyword")
	) {
		return "hazard";
	}
	if (
		type.type === "TSParenthesizedType" ||
		type.type === "TSJSDocNullableType" ||
		type.type === "TSJSDocNonNullableType"
	) {
		return resolveType(
			type.typeAnnotation,
			hazard,
			environment,
			bindings,
			visitedAliases,
			depth + 1,
		);
	}
	if (type.type === "TSUnionType") {
		return combineUnion(
			type.types.map((member) =>
				resolveType(member, hazard, environment, bindings, visitedAliases, depth + 1),
			),
		);
	}
	if (type.type === "TSIntersectionType") {
		return combineIntersection(
			type.types.map((member) =>
				resolveType(member, hazard, environment, bindings, visitedAliases, depth + 1),
			),
		);
	}
	if (type.type === "TSArrayType") {
		return resolveType(type.elementType, hazard, environment, bindings, visitedAliases, depth + 1);
	}
	if (type.type === "TSTupleType") {
		return combineUnion(
			type.elementTypes.map((element) =>
				resolveTupleElement(element, hazard, environment, bindings, visitedAliases, depth + 1),
			),
		);
	}
	if (type.type === "TSTypeReference") {
		return resolveReference(type, hazard, environment, bindings, visitedAliases, depth);
	}
	if (type.type === "TSConditionalType") {
		const trueBindings = new Map(bindings);
		collectInferTypeParameters(type.extendsType, trueBindings);
		return combineUnion([
			resolveType(type.trueType, hazard, environment, trueBindings, visitedAliases, depth + 1),
			resolveType(type.falseType, hazard, environment, bindings, visitedAliases, depth + 1),
		]);
	}
	if (type.type === "TSIndexedAccessType") {
		return combineUnion([
			resolveType(type.objectType, hazard, environment, bindings, visitedAliases, depth + 1),
			resolveType(type.indexType, hazard, environment, bindings, visitedAliases, depth + 1),
		]);
	}
	if (type.type === "TSTypeOperator") {
		return type.operator === "readonly"
			? resolveType(type.typeAnnotation, hazard, environment, bindings, visitedAliases, depth + 1)
			: "safe";
	}
	if (type.type === "TSImportType") {
		const argumentResolution = combineUnion(
			(type.typeArguments?.params ?? []).map((argument) =>
				resolveType(argument, hazard, environment, bindings, visitedAliases, depth + 1),
			),
		);
		return argumentResolution;
	}
	return "safe";
}

/** Resolve transparent wrappers, aliases, and generic arguments without type checking. */
export function resolveHazardousType(
	type: ESTree.TSType,
	hazard: HazardousType,
	environment: TypeEnvironment,
	bindings: TypeBindings = new Map(),
): TypeResolution {
	return resolveType(type, hazard, environment, bindings, new Set(), 0);
}
