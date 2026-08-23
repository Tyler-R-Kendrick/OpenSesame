import { RuleTester } from "oxlint/plugins-dev";

import { noObjectParametersRule } from "./no-object-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const object = { messageId: "objectParameter" };

tester.run("anti-slop/no-object-parameters", noObjectParametersRule, {
	valid: [
		"interface Owner { readonly id: string } function consume(value: Owner) {}",
		"function consume<Value>(value: Value) {}",
		"function consume<Value extends object>(value: Value) {}",
		"function consume<Value extends Owner, Owner extends { readonly id: string }>(value: Value) {}",
		"type Owner = { readonly id: string }; function consume<Value extends Owner>(value: Value) {}",
		"type Alias = object; function consume<Alias>(value: Alias) {}",
		"type Alias = object; type Consumer<Alias> = (value: Alias) => void;",
		"type Alias = object; interface Consumer<Alias> { consume(value: Alias): void }",
		"type Key = object; type Mapped<Input> = { [Key in keyof Input]: (value: Key) => void };",
		"type Item = object; type Unpacked<Input> = Input extends Promise<infer Item> ? (value: Item) => void : never;",
		"function consume(value: object & { readonly id: string }) {}",
		'import type { Input } from "./input.ts"; function consume(value: Input) {}',
		"function consume(value: MissingInput) {}",
		"type First = Second; type Second = First; function consume(value: First) {}",
	],
	invalid: [
		{ code: "function consume(value: object) {}", errors: [object] },
		{
			code: "type Alias = object; function consume(value: Alias) {}",
			errors: [object],
		},
		{
			code: "type Alias = object | string; function consume(value: Alias) {}",
			errors: [object],
		},
		{
			code: "type Identity<Value> = Value; function consume(value: Identity<object>) {}",
			errors: [object],
		},
		{
			code: "type Input<Value = object> = Value; function consume(value: Input) {}",
			errors: [object],
		},
		{
			code: "function consume<Value = object>(value: Value) {}",
			errors: [object],
		},
		{
			code: 'import type { Input } from "./input.ts"; function consume(value: Input<object>) {}',
			errors: [object],
		},
		{ code: "function consume(value: readonly object[]) {}", errors: [object] },
		{
			code: "type Item = object; type Fallback<Input> = Input extends infer Item ? string : (value: Item) => void;",
			errors: [object],
		},
	],
});
