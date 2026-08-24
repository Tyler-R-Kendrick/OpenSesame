import { RuleTester } from "oxlint/plugins-dev";

import { noReflectApplyRule } from "./no-reflect-apply.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "reflectApply" };

tester.run("anti-slop/no-reflect-apply", noReflectApplyRule, {
  valid: [
    "const value = operation.apply(owner, args);",
    "Reflect.get(owner, key);",
    "const Reflect = { apply() { return 1; } }; Reflect.apply();",
    "function invoke(Reflect: { apply(): number }) { return Reflect.apply(); }",
    "const localReflect = { apply() { return 1; } }; const alias = localReflect; alias.apply();",
    "const localReflect = { apply() { return 1; } }; const { apply: invoke } = localReflect; invoke();",
    "const reflection = Reflect; function invoke(reflection: { apply(): number }) { return reflection.apply(); }",
    "function invoke() { const Reflect = { apply() { return 1; } }; const reflection = Reflect; return reflection.apply(); }",
    "const method = 'apply'; Reflect[method](operation, owner, args);",
    "let reflection = Reflect; reflection = localReflect; reflection.apply();",
  ],
  invalid: [
    { code: "const value = Reflect.apply(operation, owner, args);", errors: [error] },
    { code: "const value = Reflect['apply'](operation, owner, args);", errors: [error] },
    {
      name: "Reflect object alias",
      code: "const reflection = Reflect; reflection.apply(operation, owner, args);",
      errors: [error],
    },
    {
      name: "Reflect method alias",
      code: "const invoke = Reflect.apply; invoke(operation, owner, args);",
      errors: [error],
    },
    {
      name: "destructured Reflect method",
      code: "const { apply: invoke } = Reflect; invoke(operation, owner, args);",
      errors: [error],
    },
    {
      name: "computed destructured Reflect method",
      code: "const { ['apply']: invoke } = Reflect; invoke(operation, owner, args);",
      errors: [error],
    },
    {
      name: "bounded alias chain",
      code: "const first = Reflect; const second = first; const third = second.apply; third(operation, owner, args);",
      errors: [error],
    },
    {
      name: "stable let alias",
      code: "let reflection = Reflect; reflection.apply(operation, owner, args);",
      errors: [error],
    },
  ],
});
