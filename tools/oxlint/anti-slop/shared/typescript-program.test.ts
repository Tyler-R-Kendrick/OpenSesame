import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createSingleFileProgram } from "./typescript-program.ts";

const moduleFilename = fileURLToPath(new URL("./typescript-program.ts", import.meta.url));
const testFilename = fileURLToPath(new URL("./typescript-program.test.ts", import.meta.url));

describe("createSingleFileProgram", () => {
	it("parses files outside the linted one once per process", () => {
		const first = createSingleFileProgram(testFilename, "export const first = 1;");
		const second = createSingleFileProgram(moduleFilename, "export const second = 2;");
		const firstLib = first.program.getSourceFiles().find((file) => file.hasNoDefaultLib);
		expect(firstLib).toBeDefined();
		expect(second.program.getSourceFile(firstLib?.fileName ?? "")).toBe(firstLib);
	});

	it("roots each program at the linted file only", () => {
		const { program } = createSingleFileProgram(testFilename, "export const only = 1;");
		expect(program.getRootFileNames()).toEqual([testFilename]);
	});

	it("reads the linted file from the source it was given, even once cached from disk", () => {
		const importer = createSingleFileProgram(
			testFilename,
			'import type { SingleFileProgram } from "./typescript-program.ts"; export type A = SingleFileProgram;',
		);
		const fromDisk = importer.program.getSourceFile(moduleFilename);
		expect(fromDisk?.text).toContain("createSingleFileProgram");

		const source = "export type Linted = Record<string, number>;";
		const linted = createSingleFileProgram(moduleFilename, source);
		expect(linted.sourceFile?.text).toBe(source);
		expect(linted.sourceFile).not.toBe(fromDisk);

		const again = createSingleFileProgram(
			testFilename,
			'import type { SingleFileProgram } from "./typescript-program.ts"; export type B = SingleFileProgram;',
		);
		expect(again.program.getSourceFile(moduleFilename)).toBe(fromDisk);
	});
});
