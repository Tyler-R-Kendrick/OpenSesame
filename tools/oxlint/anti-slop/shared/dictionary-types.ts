import type { ESTree } from "@oxlint/plugins";
import { resolve } from "node:path";
import ts from "typescript";

const BUILT_INS = new Set([
	"Record",
	"Readonly",
	"Partial",
	"Required",
	"Pick",
	"Omit",
	"PropertyKey",
	"NonNullable",
]);
const TRANSPARENT_WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"]);
const MAX_TYPE_RESOLUTION_DEPTH = 64;

type TypeAliasEnvironment = ReadonlyMap<string, ResolvedType>;

type ResolvedType = {
	readonly type: ESTree.TSType;
	readonly environment: TypeEnvironment;
	readonly substitutions: TypeAliasEnvironment;
};

type AliasDefinition = {
	readonly declaration: ESTree.TSTypeAliasDeclaration;
	readonly environment: TypeEnvironment;
};

type InterfaceDefinition = {
	readonly declarations: readonly ESTree.TSInterfaceDeclaration[];
	readonly environment: TypeEnvironment;
};

export type TypeImportContext = {
	readonly filename: string;
	readonly source: string;
};

type TypeScriptAnalysis = {
	readonly context: TypeImportContext;
	program?: ts.Program | null;
	sourceFile?: ts.SourceFile | null;
};

export type UnsafeDictionary = {
	readonly kind: "unsafe-dictionary";
	readonly unsafeValue: "any" | "empty-object" | "object" | "union" | "unknown";
};

export type WideningTargetKind =
	| "anonymous object"
	| "generic container"
	| "object"
	| "open dictionary"
	| "unknown";

export type WideningTarget = {
	readonly kind: WideningTargetKind;
};

export type TypeEnvironment = {
	readonly aliases: ReadonlyMap<string, AliasDefinition>;
	readonly interfaces: ReadonlyMap<string, InterfaceDefinition>;
	readonly shadowedBuiltIns: ReadonlySet<string>;
	readonly importedNames: ReadonlySet<string>;
	readonly typeScriptAnalysis?: TypeScriptAnalysis;
};

function declaredStatement(statement: ESTree.Statement): ESTree.Node | null {
	return statement.type === "ExportNamedDeclaration" ||
		statement.type === "ExportDefaultDeclaration"
		? (statement.declaration ?? null)
		: statement;
}

export function createTypeEnvironment(
	program: ESTree.Program,
	importContext?: TypeImportContext,
): TypeEnvironment {
	const aliases = new Map<string, AliasDefinition>();
	const interfaces = new Map<string, InterfaceDefinition>();
	const shadowedBuiltIns = new Set<string>();
	const importedNames = new Set<string>();
	const environment: TypeEnvironment = {
		aliases,
		interfaces,
		shadowedBuiltIns,
		importedNames,
		typeScriptAnalysis:
			importContext === undefined ? undefined : { context: importContext },
	};

	for (const statement of program.body) {
		const declaration = declaredStatement(statement);
		if (declaration?.type === "ImportDeclaration") {
			for (const specifier of declaration.specifiers) {
				importedNames.add(specifier.local.name);
				if (BUILT_INS.has(specifier.local.name)) shadowedBuiltIns.add(specifier.local.name);
			}
			continue;
		}

		if (declaration?.type === "TSTypeAliasDeclaration") {
			const existing = aliases.get(declaration.id.name);
			if (existing === undefined) {
				const definition = { declaration, environment };
				aliases.set(declaration.id.name, definition);
			}
			else shadowedBuiltIns.add(declaration.id.name);
			if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
			continue;
		}

		if (declaration?.type === "TSInterfaceDeclaration") {
			const declarations = [...(interfaces.get(declaration.id.name)?.declarations ?? [])];
			declarations.push(declaration);
			const definition = { declarations, environment };
			interfaces.set(declaration.id.name, definition);
			if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
			continue;
		}

		if (declaration?.type === "TSEnumDeclaration") {
			if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
			continue;
		}

		if (
			(declaration?.type === "ClassDeclaration" ||
				declaration?.type === "FunctionDeclaration") &&
			declaration.id !== null
		) {
			if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
		}
	}

	return environment;
}

function containsImportedReference(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	depth = 0,
): boolean {
	if (depth >= MAX_TYPE_RESOLUTION_DEPTH) return true;
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSTypeReference") {
		const name = typeReferenceName(unwrapped);
		return (
			(name !== null && environment.importedNames.has(name)) ||
			(unwrapped.typeArguments?.params.some((argument) =>
				containsImportedReference(argument, environment, depth + 1),
			) ??
				false)
		);
	}
	if (unwrapped.type === "TSUnionType" || unwrapped.type === "TSIntersectionType") {
		return unwrapped.types.some((member) =>
			containsImportedReference(member, environment, depth + 1),
		);
	}
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.some(
			(member) =>
				(member.type === "TSPropertySignature" || member.type === "TSIndexSignature") &&
				member.typeAnnotation !== null &&
				member.typeAnnotation !== undefined &&
				containsImportedReference(
					member.typeAnnotation.typeAnnotation,
					environment,
					depth + 1,
				),
		);
	}
	if (unwrapped.type === "TSMappedType" && unwrapped.typeAnnotation !== null) {
		return containsImportedReference(unwrapped.typeAnnotation, environment, depth + 1);
	}
	return false;
}

function scriptKind(filename: string): ts.ScriptKind {
	if (filename.endsWith(".tsx")) return ts.ScriptKind.TSX;
	if (filename.endsWith(".jsx")) return ts.ScriptKind.JSX;
	return ts.ScriptKind.TS;
}

function typeScriptProgram(analysis: TypeScriptAnalysis): ts.Program | null {
	if (analysis.program !== undefined) return analysis.program;
	try {
		const filename = resolve(analysis.context.filename);
		const options: ts.CompilerOptions = {
			allowImportingTsExtensions: true,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			noEmit: true,
			skipLibCheck: true,
			target: ts.ScriptTarget.ESNext,
		};
		const host = ts.createCompilerHost(options, true);
		const readSourceFile = host.getSourceFile.bind(host);
		host.getSourceFile = (requestedFilename, languageVersion, onError, shouldCreate) =>
			resolve(requestedFilename) === filename
				? ts.createSourceFile(
						filename,
						analysis.context.source,
						languageVersion,
						true,
						scriptKind(filename),
					)
				: readSourceFile(requestedFilename, languageVersion, onError, shouldCreate);
		analysis.program = ts.createProgram({ rootNames: [filename], options, host });
		analysis.sourceFile = analysis.program.getSourceFile(filename) ?? null;
	} catch {
		analysis.program = null;
		analysis.sourceFile = null;
	}
	return analysis.program;
}

function matchingTypeNode(
	sourceFile: ts.SourceFile,
	start: number,
	end: number,
): ts.TypeNode | null {
	let match: ts.TypeNode | null = null;
	const visit = (node: ts.Node): void => {
		if (match !== null || node.pos > start || node.end < end) return;
		if (ts.isTypeNode(node) && node.getStart(sourceFile) === start && node.end === end) {
			match = node;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return match;
}

function typeScriptDictionaryValues(
	type: ts.Type,
	checker: ts.TypeChecker,
	resolving: ReadonlySet<ts.Type>,
	depth = 0,
): DictionaryValueResolutionTs {
	if (depth >= MAX_TYPE_RESOLUTION_DEPTH) return { values: [], truncated: true };
	if (resolving.has(type)) return { values: [], truncated: false };
	const nextResolving = new Set(resolving);
	nextResolving.add(type);
	if (type.isUnionOrIntersection()) {
		const resolutions = type.types.map((member) =>
			typeScriptDictionaryValues(member, checker, nextResolving, depth + 1),
		);
		return {
			values: resolutions.flatMap((resolution) => resolution.values),
			truncated: resolutions.some((resolution) => resolution.truncated),
		};
	}
	const values = new Set<ts.Type>();
	const stringValue = checker.getIndexTypeOfType(type, ts.IndexKind.String);
	const numberValue = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
	if (stringValue !== undefined) values.add(stringValue);
	if (numberValue !== undefined) values.add(numberValue);
	return { values: [...values], truncated: false };
}

type DictionaryValueResolutionTs = {
	readonly values: readonly ts.Type[];
	readonly truncated: boolean;
};

function unsafeTypeScriptValue(
	type: ts.Type,
	checker: ts.TypeChecker,
	resolving: ReadonlySet<ts.Type>,
	depth = 0,
): UnsafeDictionary["unsafeValue"] | null {
	if (depth >= MAX_TYPE_RESOLUTION_DEPTH) return "unknown";
	if ((type.flags & ts.TypeFlags.Any) !== 0) return "any";
	if ((type.flags & ts.TypeFlags.Unknown) !== 0) return "unknown";
	if ((type.flags & ts.TypeFlags.NonPrimitive) !== 0) return "object";
	if (resolving.has(type)) return null;
	const nextResolving = new Set(resolving);
	nextResolving.add(type);
	if (type.isUnion()) {
		return type.types.some(
			(member) =>
				unsafeTypeScriptValue(member, checker, nextResolving, depth + 1) !== null,
		)
			? "union"
			: null;
	}
	if (type.isIntersection()) {
		const unsafe = type.types.map((member) =>
			unsafeTypeScriptValue(member, checker, nextResolving, depth + 1),
		);
		if (unsafe.includes("any")) return "any";
		return unsafe.length > 0 && unsafe.every((member) => member !== null) ? unsafe[0] : null;
	}
	if (
		(type.flags & ts.TypeFlags.Object) !== 0 &&
		checker.getPropertiesOfType(type).length === 0 &&
		checker.getSignaturesOfType(type, ts.SignatureKind.Call).length === 0 &&
		checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length === 0 &&
		checker.getIndexTypeOfType(type, ts.IndexKind.String) === undefined &&
		checker.getIndexTypeOfType(type, ts.IndexKind.Number) === undefined
	) {
		return "empty-object";
	}
	return null;
}

function classifyImportedType(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	valueOnly: boolean,
): UnsafeDictionary | null {
	const analysis = environment.typeScriptAnalysis;
	if (analysis === undefined || !containsImportedReference(type, environment)) return null;
	const program = typeScriptProgram(analysis);
	const sourceFile = analysis.sourceFile;
	if (program === null || sourceFile === null || sourceFile === undefined) return null;
	const typeNode = matchingTypeNode(sourceFile, type.start, type.end);
	if (typeNode === null) return null;
	const checker = program.getTypeChecker();
	const resolved = checker.getTypeAtLocation(typeNode);
	if (valueOnly) {
		const unsafeValue = unsafeTypeScriptValue(resolved, checker, new Set());
		return unsafeValue === null ? null : { kind: "unsafe-dictionary", unsafeValue };
	}
	const values = typeScriptDictionaryValues(resolved, checker, new Set());
	if (values.truncated) return { kind: "unsafe-dictionary", unsafeValue: "unknown" };
	for (const value of values.values) {
		const unsafeValue = unsafeTypeScriptValue(value, checker, new Set());
		if (unsafeValue !== null) return { kind: "unsafe-dictionary", unsafeValue };
	}
	return null;
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
	return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isBuiltIn(name: string, environment: TypeEnvironment): boolean {
	return BUILT_INS.has(name) && !environment.shadowedBuiltIns.has(name);
}

function isUnappliedReferenceTo(type: ESTree.TSType, name: string): boolean {
	const unwrapped = unwrapTransparentType(type);
	return (
		unwrapped.type === "TSTypeReference" &&
		typeReferenceName(unwrapped) === name &&
		(unwrapped.typeArguments === null ||
			unwrapped.typeArguments === undefined ||
			unwrapped.typeArguments.params.length === 0)
	);
}

function unwrapTransparentType(type: ESTree.TSType): ESTree.TSType {
	let current = type;
	while (
		current.type === "TSParenthesizedType" ||
		(current.type === "TSTypeOperator" && current.operator === "readonly")
	) {
		current = current.typeAnnotation;
	}
	return current;
}

function isNeverType(type: ESTree.TSType): boolean {
	return unwrapTransparentType(type).type === "TSNeverKeyword";
}

function isEffectivelyEmptyMember(member: ESTree.TSSignature): boolean {
	return (
		member.type === "TSPropertySignature" &&
		member.optional === true &&
		member.typeAnnotation !== null &&
		member.typeAnnotation !== undefined &&
		isNeverType(member.typeAnnotation.typeAnnotation)
	);
}

function isEffectivelyEmptyTypeLiteral(type: ESTree.TSTypeLiteral): boolean {
	return type.members.length === 0 || type.members.every(isEffectivelyEmptyMember);
}

function isEffectivelyEmptyInterface(
	declarations: readonly ESTree.TSInterfaceDeclaration[],
): boolean {
	return (
		declarations.length > 0 &&
		declarations.every(
			(type) =>
				type.extends.length === 0 &&
				(type.body.body.length === 0 || type.body.body.every(isEffectivelyEmptyMember)),
		)
	);
}

function resolvedSubstitutionArgument(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	base: TypeAliasEnvironment,
	resolving: ReadonlySet<string> = new Set(),
	depth = 0,
): ResolvedType {
	const unresolved = { type, environment, substitutions: base };
	if (depth >= MAX_TYPE_RESOLUTION_DEPTH) return unresolved;
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type !== "TSTypeReference") return unresolved;
	const name = typeReferenceName(unwrapped);
	if (name === null || resolving.has(name)) return unresolved;
	const substitution = base.get(name);
	if (substitution === undefined) return unresolved;
	const nextResolving = new Set(resolving);
	nextResolving.add(name);
	return resolvedSubstitutionArgument(
		substitution.type,
		substitution.environment,
		substitution.substitutions,
		nextResolving,
		depth + 1,
	);
}

function aliasSubstitution(
	alias: AliasDefinition,
	type: ESTree.TSTypeReference,
	callerEnvironment: TypeEnvironment,
	base: TypeAliasEnvironment,
	depth: number,
): TypeAliasEnvironment | null {
	const parameters = alias.declaration.typeParameters?.params ?? [];
	const arguments_ = type.typeArguments?.params ?? [];
	const next = new Map<string, ResolvedType>();
	for (const [index, parameter] of parameters.entries()) {
		const explicitArgument = arguments_[index];
		const argument = explicitArgument ?? parameter.default;
		if (argument === null || argument === undefined) return null;
		next.set(
			parameter.name.name,
			resolvedSubstitutionArgument(
				argument,
				explicitArgument === undefined ? alias.environment : callerEnvironment,
				explicitArgument === undefined ? next : base,
				new Set(),
				depth + 1,
			),
		);
	}
	return next;
}

function unsafeDirectValue(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
	depth = 0,
): UnsafeDictionary["unsafeValue"] | null {
	if (depth >= MAX_TYPE_RESOLUTION_DEPTH) return "unknown";
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return "unknown";
	if (unwrapped.type === "TSAnyKeyword") return "any";
	if (unwrapped.type === "TSObjectKeyword") return "object";
	if (unwrapped.type === "TSTypeLiteral" && isEffectivelyEmptyTypeLiteral(unwrapped))
		return "empty-object";
	if (unwrapped.type === "TSUnionType") {
		return unwrapped.types.some(
			(member) =>
				unsafeDirectValue(
					member,
					environment,
					substitutions,
					resolvingAliases,
					depth + 1,
				) !== null,
		)
			? "union"
			: null;
	}
	if (unwrapped.type === "TSIntersectionType") {
		const unsafeMembers = unwrapped.types.map((member) =>
			unsafeDirectValue(member, environment, substitutions, resolvingAliases, depth + 1),
		);
		if (unsafeMembers.includes("any")) return "any";
		return unsafeMembers.length > 0 && unsafeMembers.every((member) => member !== null)
			? unsafeMembers[0]
			: null;
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? null
			: unsafeDirectValue(
					wrapped,
					environment,
					substitutions,
					resolvingAliases,
					depth + 1,
				);
	}
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution.type, name)
			? null
			: unsafeDirectValue(
					substitution.type,
					substitution.environment,
					substitution.substitutions,
					resolvingAliases,
					depth + 1,
				);
	}
	const interfaceDefinition = environment.interfaces.get(name);
	if (interfaceDefinition !== undefined) {
		return isEffectivelyEmptyInterface(interfaceDefinition.declarations)
			? "empty-object"
			: null;
	}
	const alias = environment.aliases.get(name);
	if (alias === undefined || resolvingAliases.has(alias.declaration)) return null;
	const nextSubstitutions = aliasSubstitution(
		alias,
		unwrapped,
		environment,
		substitutions,
		depth,
	);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias.declaration);
	return unsafeDirectValue(
		alias.declaration.typeAnnotation,
		alias.environment,
		nextSubstitutions,
		nextResolving,
		depth + 1,
	);
}

type DictionaryValueResolution = {
	readonly values: readonly ResolvedType[];
	readonly truncated: boolean;
};

function combineDictionaryValues(
	resolutions: readonly DictionaryValueResolution[],
): DictionaryValueResolution {
	return {
		values: resolutions.flatMap((resolution) => resolution.values),
		truncated: resolutions.some((resolution) => resolution.truncated),
	};
}

function dictionaryValueTypes(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
	depth = 0,
): DictionaryValueResolution {
	if (depth >= MAX_TYPE_RESOLUTION_DEPTH) return { values: [], truncated: true };
	const unwrapped = unwrapTransparentType(type);

	if (unwrapped.type === "TSTypeLiteral") {
		return {
			values: unwrapped.members.flatMap((member): readonly ResolvedType[] =>
				member.type === "TSIndexSignature" && member.typeAnnotation !== null
					? [{ type: member.typeAnnotation.typeAnnotation, environment, substitutions }]
					: [],
			),
			truncated: false,
		};
	}

	if (unwrapped.type === "TSMappedType") {
		return unwrapped.typeAnnotation === null
			? { values: [], truncated: false }
			: {
					values: [{ type: unwrapped.typeAnnotation, environment, substitutions }],
					truncated: false,
				};
	}

	if (unwrapped.type === "TSUnionType" || unwrapped.type === "TSIntersectionType") {
		return combineDictionaryValues(
			unwrapped.types.map((member) =>
				dictionaryValueTypes(
					member,
					environment,
					substitutions,
					resolvingAliases,
					depth + 1,
				),
			),
		);
	}

	if (unwrapped.type !== "TSTypeReference") return { values: [], truncated: false };
	const name = typeReferenceName(unwrapped);
	if (name === null) return { values: [], truncated: false };

	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution.type, name)
			? { values: [], truncated: false }
			: dictionaryValueTypes(
					substitution.type,
					substitution.environment,
					substitution.substitutions,
					resolvingAliases,
					depth + 1,
				);
	}

	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? { values: [], truncated: false }
			: dictionaryValueTypes(
					wrapped,
					environment,
					substitutions,
					resolvingAliases,
					depth + 1,
				);
	}

	if (name === "Record" && isBuiltIn(name, environment)) {
		const value = unwrapped.typeArguments?.params[1] ?? null;
		return value === null
			? { values: [], truncated: false }
			: { values: [{ type: value, environment, substitutions }], truncated: false };
	}

	if ((name === "Pick" || name === "Omit") && isBuiltIn(name, environment)) {
		const source = unwrapped.typeArguments?.params[0];
		return source === undefined
			? { values: [], truncated: false }
			: dictionaryValueTypes(
					source,
					environment,
					substitutions,
					resolvingAliases,
					depth + 1,
				);
	}

	const alias = environment.aliases.get(name);
	if (alias === undefined || resolvingAliases.has(alias.declaration)) {
		return { values: [], truncated: false };
	}
	const nextSubstitutions = aliasSubstitution(
		alias,
		unwrapped,
		environment,
		substitutions,
		depth,
	);
	if (nextSubstitutions === null) return { values: [], truncated: false };
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias.declaration);
	return dictionaryValueTypes(
		alias.declaration.typeAnnotation,
		alias.environment,
		nextSubstitutions,
		nextResolving,
		depth + 1,
	);
}

export function classifyUnsafeDictionaryValue(
	valueType: ESTree.TSType,
	environment: TypeEnvironment,
): UnsafeDictionary | null {
	const unsafeValue = unsafeDirectValue(valueType, environment, new Map(), new Set());
	return unsafeValue === null
		? classifyImportedType(valueType, environment, true)
		: { kind: "unsafe-dictionary", unsafeValue };
}

export function classifyUnsafeDictionary(
	type: ESTree.TSType,
	environment: TypeEnvironment,
): UnsafeDictionary | null {
	const resolution = dictionaryValueTypes(type, environment, new Map(), new Set());
	if (resolution.truncated) return { kind: "unsafe-dictionary", unsafeValue: "unknown" };
	for (const valueType of resolution.values) {
		const unsafeValue = unsafeDirectValue(
			valueType.type,
			valueType.environment,
			valueType.substitutions,
			new Set(),
		);
		if (unsafeValue !== null) return { kind: "unsafe-dictionary", unsafeValue };
	}
	return classifyImportedType(type, environment, false);
}

function resolvesToDictionary(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
): boolean {
	const resolution = dictionaryValueTypes(type, environment, substitutions, resolvingAliases);
	return resolution.truncated || resolution.values.length > 0;
}

export function classifyWideningTarget(
	type: ESTree.TSType,
	environment: TypeEnvironment,
): WideningTarget | null {
	return classifyWideningTargetAt(type, environment, 0);
}

function classifyWideningTargetAt(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	depth: number,
): WideningTarget | null {
	if (depth >= MAX_TYPE_RESOLUTION_DEPTH) return { kind: "unknown" };
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
	if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.some((member) => member.type === "TSIndexSignature")
			? { kind: "open dictionary" }
			: unwrapped.members.length > 0
				? { kind: "anonymous object" }
				: null;
	}
	if (unwrapped.type === "TSMappedType") return { kind: "open dictionary" };
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? null
			: classifyWideningTargetAt(wrapped, environment, depth + 1);
	}
	if (name === "Record" && isBuiltIn(name, environment)) return { kind: "open dictionary" };
	const alias = environment.aliases.get(name);
	if (alias === undefined) return null;
	if ((alias.declaration.typeParameters?.params.length ?? 0) > 0) {
		const substitutions = aliasSubstitution(alias, unwrapped, environment, new Map(), depth);
		return substitutions !== null &&
			resolvesToDictionary(
				alias.declaration.typeAnnotation,
				alias.environment,
				substitutions,
				new Set([alias.declaration]),
			)
			? { kind: "generic container" }
			: null;
	}
	const substitutions = aliasSubstitution(alias, unwrapped, environment, new Map(), depth);
	if (substitutions === null) return null;
	const resolved = classifyAliasBroadTarget(
		alias.declaration.typeAnnotation,
		alias.environment,
		substitutions,
		new Set([alias.declaration]),
		depth + 1,
	);
	return resolved;
}

function isBroadMappedKey(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	depth = 0,
): boolean {
	if (depth >= MAX_TYPE_RESOLUTION_DEPTH) return true;
	const unwrapped = unwrapTransparentType(type);
	if (
		unwrapped.type === "TSStringKeyword" ||
		unwrapped.type === "TSNumberKeyword" ||
		unwrapped.type === "TSSymbolKeyword"
	) {
		return true;
	}
	if (unwrapped.type === "TSUnionType") {
		return unwrapped.types.every((member) =>
			isBroadMappedKey(member, environment, substitutions, depth + 1),
		);
	}
	if (unwrapped.type !== "TSTypeReference") return false;
	const name = typeReferenceName(unwrapped);
	if (name === null) return false;
	const substitution = substitutions.get(name);
	if (substitution !== undefined && !isUnappliedReferenceTo(substitution.type, name)) {
		return isBroadMappedKey(
			substitution.type,
			substitution.environment,
			substitution.substitutions,
			depth + 1,
		);
	}
	return name === "PropertyKey" && isBuiltIn(name, environment);
}

function classifyAliasBroadTarget(
	type: ESTree.TSType,
	environment: TypeEnvironment,
	substitutions: TypeAliasEnvironment,
	resolvingAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
	depth: number,
): WideningTarget | null {
	if (depth >= MAX_TYPE_RESOLUTION_DEPTH) return { kind: "unknown" };
	const unwrapped = unwrapTransparentType(type);
	if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
	if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
	if (unwrapped.type === "TSTypeLiteral") {
		return unwrapped.members.some((member) => member.type === "TSIndexSignature")
			? { kind: "open dictionary" }
			: null;
	}
	if (unwrapped.type === "TSMappedType") {
		return isBroadMappedKey(unwrapped.constraint, environment, substitutions, depth + 1)
			? { kind: "open dictionary" }
			: null;
	}
	if (unwrapped.type !== "TSTypeReference") return null;
	const name = typeReferenceName(unwrapped);
	if (name === null) return null;
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution.type, name)
			? null
			: classifyAliasBroadTarget(
					substitution.type,
					substitution.environment,
					substitution.substitutions,
					resolvingAliases,
					depth + 1,
				);
	}
	if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
		const wrapped = unwrapped.typeArguments?.params[0];
		return wrapped === undefined
			? null
			: classifyAliasBroadTarget(
					wrapped,
					environment,
					substitutions,
					resolvingAliases,
					depth + 1,
				);
	}
	if (name === "Record" && isBuiltIn(name, environment)) {
		return { kind: "open dictionary" };
	}
	const alias = environment.aliases.get(name);
	if (alias === undefined || resolvingAliases.has(alias.declaration)) return null;
	const nextSubstitutions = aliasSubstitution(
		alias,
		unwrapped,
		environment,
		substitutions,
		depth,
	);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(alias.declaration);
	return classifyAliasBroadTarget(
		alias.declaration.typeAnnotation,
		alias.environment,
		nextSubstitutions,
		nextResolving,
		depth + 1,
	);
}

export function isPopulatedObjectExpression(expression: ESTree.Expression): boolean {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression"
	) {
		current = current.expression;
	}
	return current.type === "ObjectExpression" && current.properties.length > 0;
}

export function isKnownEvidenceExpression(expression: ESTree.Expression): boolean {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression" ||
		current.type === "TSSatisfiesExpression"
	) {
		current = current.expression;
	}
	if (current.type === "ObjectExpression") return true;
	return (
		current.type === "ArrayExpression" ||
		current.type === "ArrowFunctionExpression" ||
		current.type === "ClassExpression" ||
		current.type === "FunctionExpression" ||
		current.type === "NewExpression" ||
		current.type === "Literal" ||
		current.type === "TemplateLiteral" ||
		current.type === "UnaryExpression"
	);
}
