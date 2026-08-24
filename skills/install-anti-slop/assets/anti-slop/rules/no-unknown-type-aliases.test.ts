import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownTypeAliasesRule } from "./no-unknown-type-aliases.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const unknown = { messageId: "unknownAlias" };

tester.run("anti-slop/no-unknown-type-aliases", noUnknownTypeAliasesRule, {
	valid: [
		"type User = { readonly id: string };",
		"type Alias = string; type UserId = Alias;",
		"interface User { readonly id: string } type Alias = User;",
		"type Identity<Value> = Value;",
		"type Maybe<Value> = Value | string;",
		"type Narrowed = unknown & string;",
		"type ErrorDetail = { readonly cause: unknown };",
		'import type { External } from "./external.ts"; type Alias = External;',
		'type Alias = import("./external.ts").External;',
		"type Alias = Missing;",
		"type First = Second; type Second = First;",
		"type Box<Value> = Value; type Alias = Box;",
	],
	invalid: [
		{ code: "type Alias = unknown;", errors: [unknown] },
		{ code: "type Alias = string | unknown;", errors: [unknown] },
		{
			code: "type UnknownValue = unknown; type Alias = UnknownValue;",
			errors: [unknown, unknown],
		},
		{ code: "type Identity<Value = unknown> = Value;", errors: [unknown] },
		{
			code: "type Identity<Value> = Value; type Alias = Identity<unknown>;",
			errors: [unknown],
		},
		{
			code: 'import type { External } from "./external.ts"; type Alias = External<unknown>;',
			errors: [unknown],
		},
	],
});
