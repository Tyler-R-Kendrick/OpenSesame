import { RuleTester } from "oxlint/plugins-dev";

import { noReflectGetRule } from "./no-reflect-get.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "reflectGet" };

tester.run("anti-slop/no-reflect-get", noReflectGetRule, {
  valid: [
    "const value = owner.property;",
    "const value = owner[key];",
    "Reflect.set(owner, key, value);",
    "const Reflect = { get() { return 1; } }; Reflect.get();",
    "function read(Reflect: { get(): number }) { return Reflect.get(); }",
    "const localReflect = { get() { return 1; } }; const alias = localReflect; alias.get();",
    "const localReflect = { get() { return 1; } }; const { get: read } = localReflect; read();",
    "const reflection = Reflect; function read(reflection: { get(): number }) { return reflection.get(); }",
    "function read() { const Reflect = { get() { return 1; } }; const reflection = Reflect; return reflection.get(); }",
    "const method = 'get'; Reflect[method](owner, key);",
    "let reflection = Reflect; reflection = localReflect; reflection.get(owner, key);",
  ],
  invalid: [
    { name: "static access", code: "const value = Reflect.get(owner, key);", errors: [error] },
    { name: "computed access", code: "const value = Reflect['get'](owner, key);", errors: [error] },
    {
      name: "Reflect object alias",
      code: "const reflection = Reflect; const value = reflection.get(owner, key);",
      errors: [error],
    },
    {
      name: "Reflect method alias",
      code: "const read = Reflect.get; const value = read(owner, key);",
      errors: [error],
    },
    {
      name: "destructured Reflect method",
      code: "const { get: read } = Reflect; const value = read(owner, key);",
      errors: [error],
    },
    {
      name: "computed destructured Reflect method",
      code: "const { ['get']: read } = Reflect; const value = read(owner, key);",
      errors: [error],
    },
    {
      name: "bounded alias chain",
      code: "const first = Reflect; const second = first; const third = second.get; const value = third(owner, key);",
      errors: [error],
    },
    {
      name: "stable let alias",
      code: "let reflection = Reflect; const value = reflection.get(owner, key);",
      errors: [error],
    },
  ],
});
