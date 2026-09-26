import { resolve } from "node:path";
import ts from "typescript";

// One linted file is one Program whose only root is that file, exactly as
// before. What is shared across the files a process lints is the parse of
// everything else: the lib `.d.ts` files and the import graph are read from
// disk once and handed to every later Program, where they used to be reparsed
// (and rebound) for each linted file. The linted file itself always comes from
// the in-memory source Oxlint passed, never from the cache.
const OPTIONS: ts.CompilerOptions = {
	allowImportingTsExtensions: true,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	noEmit: true,
	skipLibCheck: true,
	target: ts.ScriptTarget.ESNext,
};

type SharedHost = {
	readonly host: ts.CompilerHost;
	readonly sourceFiles: Map<string, ts.SourceFile>;
};

let shared: SharedHost | null = null;

function sharedHost(): SharedHost {
	if (shared !== null) return shared;
	const host = ts.createCompilerHost(OPTIONS, true);
	const sourceFiles = new Map<string, ts.SourceFile>();
	const readSourceFile = host.getSourceFile.bind(host);
	// The path alone is the key: every Program here has the same OPTIONS, so a
	// file's parse options (target, module format from its package.json scope,
	// JSDoc mode) are the same every time TypeScript asks for it.
	host.getSourceFile = (filename, languageVersion, onError, shouldCreate) => {
		const key = resolve(filename);
		const cached = shouldCreate === true ? undefined : sourceFiles.get(key);
		if (cached !== undefined) return cached;
		const sourceFile = readSourceFile(filename, languageVersion, onError, shouldCreate);
		if (sourceFile !== undefined) sourceFiles.set(key, sourceFile);
		return sourceFile;
	};
	const moduleResolution = ts.createModuleResolutionCache(
		host.getCurrentDirectory(),
		host.getCanonicalFileName,
		OPTIONS,
	);
	host.getModuleResolutionCache = () => moduleResolution;
	// The same call TypeScript's default loader makes, against one cache for
	// the process instead of a fresh one per Program.
	host.resolveModuleNameLiterals = (literals, containingFile, redirected, options, file) =>
		literals.map((literal) =>
			ts.resolveModuleName(
				literal.text,
				containingFile,
				options,
				host,
				moduleResolution,
				redirected,
				ts.getModeForUsageLocation(file, literal, redirected?.commandLine.options ?? options),
			),
		);
	shared = { host, sourceFiles };
	return shared;
}

function scriptKind(filename: string): ts.ScriptKind {
	if (filename.endsWith(".tsx")) return ts.ScriptKind.TSX;
	if (filename.endsWith(".jsx")) return ts.ScriptKind.JSX;
	return ts.ScriptKind.TS;
}

export type SingleFileProgram = {
	readonly program: ts.Program;
	readonly sourceFile: ts.SourceFile | null;
};

export function createSingleFileProgram(
	requestedFilename: string,
	source: string,
): SingleFileProgram {
	const filename = resolve(requestedFilename);
	const { host: base } = sharedHost();
	const host: ts.CompilerHost = {
		...base,
		getSourceFile: (requested, languageVersion, onError, shouldCreate) =>
			resolve(requested) === filename
				? ts.createSourceFile(filename, source, languageVersion, true, scriptKind(filename))
				: base.getSourceFile(requested, languageVersion, onError, shouldCreate),
	};
	const program = ts.createProgram({ rootNames: [filename], options: OPTIONS, host });
	return { program, sourceFile: program.getSourceFile(filename) ?? null };
}
