import { RuleTester } from "oxlint/plugins-dev";

import { noWidenThenAssertRule } from "./no-widen-then-assert.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "widenThenAssert" };

tester.run("anti-slop/no-widen-then-assert", noWidenThenAssertRule, {
	valid: [
		"const source = { id: 'first' }; const widened: unknown = source;",
		"declare const input: unknown; const parsed = input as { readonly id: string };",
		"const source = { id: 'changed' }; let widened: unknown = source; widened = getExternalValue(); const parsed = widened as { readonly id: string };",
		"const source = { id: 'changed' }; let widened: unknown = source; const parse = () => widened as { readonly id: string };",
	],
	invalid: [
		{
			code: "const source = { id: 'second' }; const widened: unknown = source; const parsed = widened as { readonly id: string };",
			errors: [error],
		},
		{
			code: "const source = { id: 'mutable' }; let widened: unknown = source; const parsed = widened as { readonly id: string };",
			errors: [error],
		},
		{
			code: "const source = { id: 'later-write' }; let widened: unknown = source; const parsed = widened as { readonly id: string }; widened = getExternalValue();",
			errors: [error],
		},
		{
			code: "const source = { id: 'captured' }; const alias = source; const widened: unknown = alias; const parse = () => widened as { readonly id: string };",
			errors: [error],
		},
	],
});
