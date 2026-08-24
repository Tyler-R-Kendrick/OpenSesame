import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownReturnsRule } from "./no-unknown-returns.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const unknown = { messageId: "unknownReturn" };

tester.run("anti-slop/no-unknown-returns", noUnknownReturnsRule, {
	valid: [
		"interface User { readonly id: string } function parse(): User { return user; }",
		"function infer() { return input; }",
		"const infer = () => 42;",
		"function generic<Value>(): Value { return value; }",
		"type Value = unknown; function generic<Value>(): Value { return value; }",
		"type Key = unknown; type Mapped<Input> = { [Key in keyof Input]: () => Key };",
		"type Item = unknown; type Unpacked<Input> = Input extends Promise<infer Item> ? () => Item : never;",
		"function cause(): { cause: unknown } { return { cause: input }; }",
		"type Result = { value: unknown }; function load(): Result { return result; }",
		"interface User { readonly id: string } function load(): Promise<User> { return promise; }",
		"const echo = (value: string) => value;",
		"const resolved = (value: string) => Promise.resolve(value);",
		'import type { Result } from "./result.ts"; function load(): Result { return value; }',
		'import type { Input } from "./input.ts"; const echo = (value: Input) => value;',
		"function load(): MissingResult { return value; }",
		"type First = Second; type Second = First; function load(): First { return value; }",
	],
	invalid: [
		{ code: "function load(): unknown { return input; }", errors: [unknown] },
		{ code: "const load = (): unknown => input;", errors: [unknown] },
		{ code: "type Loader = () => unknown;", errors: [unknown] },
		{ code: "interface Loader { load(): unknown }", errors: [unknown] },
		{ code: "declare function load(): unknown;", errors: [unknown] },
		{ code: "function load(): string | unknown { return input; }", errors: [unknown] },
		{ code: "function load(): Promise<unknown> { return promise; }", errors: [unknown] },
		{
			code: "type UnknownValue = unknown; function load(): UnknownValue { return input; }",
			errors: [unknown],
		},
		{
			code: "type Identity<Value> = Value; function load(): Identity<unknown> { return input; }",
			errors: [unknown],
		},
		{
			code: "type Result<Value = unknown> = Value; function load(): Result { return input; }",
			errors: [unknown],
		},
		{
			code: "function load<Value = unknown>(): Value { return value; }",
			errors: [unknown],
		},
		{
			code: 'import type { Result } from "./result.ts"; function load(): Result<unknown> { return value; }',
			errors: [unknown],
		},
		{ code: "const echo = (value: unknown) => value;", errors: [unknown] },
		{
			code: "function echo(value: unknown) { return value; }",
			errors: [unknown],
		},
		{
			code: "const echo = <Value = unknown>(value: Value) => value;",
			errors: [unknown],
		},
		{ code: "function load() { return input as unknown; }", errors: [unknown] },
		{
			code: "const choose = (value: unknown, fallback: string) => flag ? value : fallback;",
			errors: [unknown],
		},
		{
			code: "const resolved = (value: unknown) => Promise.resolve(value);",
			errors: [unknown],
		},
		{
			code: "type Item = unknown; type Fallback<Input> = Input extends infer Item ? string : () => Item;",
			errors: [unknown],
		},
	],
});
