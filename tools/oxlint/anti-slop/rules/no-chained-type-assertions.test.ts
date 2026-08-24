import { RuleTester } from "oxlint/plugins-dev";

import { noChainedTypeAssertionsRule } from "./no-chained-type-assertions.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "chained" };

tester.run("anti-slop/no-chained-type-assertions", noChainedTypeAssertionsRule, {
  valid: [
    "const user = value as User;",
    "const literal = value as const;",
    "const pair = [left as Left, right as Right];",
  ],
  invalid: [
    { code: "const user = value as unknown as User;", errors: [error] },
    { code: "const user = (value as unknown) as User;", errors: [error] },
    { code: "const user = <User><unknown>value;", errors: [error] },
    { code: "const user = ((value as Source)) as User;", errors: [error] },
  ],
});
