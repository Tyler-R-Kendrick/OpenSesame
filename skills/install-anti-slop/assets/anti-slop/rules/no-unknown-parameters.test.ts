import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const unknown = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
	valid: [
		"interface Input { readonly id: string } function parse(input: Input) {}",
		"function enrich(cause: unknown) {}",
		"function parse(input: string | number) {}",
		"function identity<Value>(value: Value) {}",
		"function identity<Value extends unknown>(value: Value) {}",
		"type Value = unknown; function identity<Value>(value: Value) {}",
		"function parse(input: unknown & string) {}",
		"type Result = { readonly value: unknown }; function inspect(result: Result) {}",
		"function construct(options: ErrorOptions) {}",
		'import type { Input } from "./input.ts"; function parse(input: Input) {}',
		"function parse(input: MissingInput) {}",
		"type A = B; type B = A; function parse(input: A) {}",
	],
	invalid: [
		{ code: "function parse(input: unknown) {}", errors: [unknown] },
		{ code: "function parse(input: string | unknown) {}", errors: [unknown] },
		{
			code: "type Input = unknown; type Alias = Input; function parse(input: Alias) {}",
			errors: [unknown],
		},
		{
			code: "type Identity<Value> = Value; function parse(input: Identity<unknown>) {}",
			errors: [unknown],
		},
		{
			code: "type Input<Value = unknown> = Value; function parse(input: Input) {}",
			errors: [unknown],
		},
		{
			code: "function parse<Value = unknown>(input: Value) {}",
			errors: [unknown],
		},
		{
			code: 'import type { Input } from "./input.ts"; function parse(input: Input<unknown>) {}',
			errors: [unknown],
		},
		{ code: "function enrich(cause: unknown | Error) {}", errors: [unknown] },
		{
			code: "type Cause = unknown; function enrich(cause: Cause) {}",
			errors: [unknown],
		},
		{ code: "function enrich(...cause: unknown[]) {}", errors: [unknown] },
		{ code: "function parse(input: readonly unknown[]) {}", errors: [unknown] },
		{ code: "function parse(input: [string, unknown]) {}", errors: [unknown] },
	],
});
