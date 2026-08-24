import { RuleTester } from "oxlint/plugins-dev";

import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });
const error = { messageId: "forbiddenSymbolName" };

tester.run("anti-slop/no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
  valid: [
    "const accountRecord = { 'shape': 1 };",
    "const value = accountRecord['shape'];",
    "type AccountContract = { id: string };",
    "const panel = <AccountPanel />;",
  ],
  invalid: [
    { code: "const shape = 1;", errors: [error] },
    { code: "type AccountShape = { id: string };", errors: [error] },
    { code: "class ShapeReader {}", errors: [error] },
    { code: "const value = account.shape;", errors: [error] },
    { code: "class Account { #shape = 1; }", errors: [error] },
    { code: "const panel = <ShapePanel />;", errors: [error] },
  ],
});
