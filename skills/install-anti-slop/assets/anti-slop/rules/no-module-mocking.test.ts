import { RuleTester } from "oxlint/plugins-dev";

import { noModuleMockingRule } from "./no-module-mocking.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "moduleMock" };

tester.run("anti-slop/no-module-mocking", noModuleMockingRule, {
  valid: [
    "const store = new InMemoryUserStore();",
    "vi.spyOn(store, 'save');",
    "const vi = { mock() {} }; vi.mock();",
    "function test(jest: { mock(): void }) { jest.mock(); }",
    "import { vi as localVi } from './helpers'; localVi.mock('./module');",
    "import * as testing from './helpers'; testing.vi.mock('./module');",
    "const localReflector = { vi: { mock() {} } }; const { vi: localVi } = localReflector; localVi.mock();",
    "function invoke(vi: { mock(name: string): void }) { vi.mock('./module'); }",
    "const jest = factory(); const { setMock } = jest; setMock('./module', factory);",
    "const property = 'mock'; vi[property]('./module');",
    "let testApi = vi; testApi = localApi; testApi.mock('./module');",
    "const localApi = { mock(name: string) { return name; } }; const replaceModule = (name: string) => localApi.mock(name); replaceModule('./module');",
    "import * as testing from 'vitest'; function run(testing: { vi: { mock(name: string): void } }) { testing.vi.mock('./module'); }",
  ],
  invalid: [
    { code: "vi.mock('./user-store');", errors: [error] },
    { code: "jest.mock('./user-store');", errors: [error] },
    { code: "vi['doMock']('./user-store');", errors: [error] },
    { code: "jest.unstable_mockModule('./user-store');", errors: [error] },
    { code: "import { vi } from 'vitest'; vi.mock('./user-store');", errors: [error] },
    { code: "import { vi as testApi } from 'vitest'; testApi.mock('./user-store');", errors: [error] },
    {
      code: "import { jest } from '@jest/globals'; jest.mock('./user-store');",
      errors: [error],
    },
    { code: "jest.setMock('./user-store', factory);", errors: [error] },
    {
      name: "Vitest namespace import",
      code: "import * as testing from 'vitest'; testing.vi.mock('./user-store');",
      errors: [error],
    },
    {
      name: "Jest namespace import",
      code: "import * as testing from '@jest/globals'; testing.jest.setMock('./user-store', factory);",
      errors: [error],
    },
    {
      name: "namespace alias chain",
      code: "import * as testing from 'vitest'; const namespace = testing; const testApi = namespace.vi; testApi.doMock('./user-store');",
      errors: [error],
    },
    {
      name: "destructured framework and method aliases",
      code: "import * as testing from 'vitest'; const { vi: testApi } = testing; const { mock: replaceModule } = testApi; replaceModule('./user-store');",
      errors: [error],
    },
    {
      name: "nested destructuring",
      code: "import * as testing from '@jest/globals'; const { jest: { setMock: replaceModule } } = testing; replaceModule('./user-store', factory);",
      errors: [error],
    },
    {
      name: "computed method alias",
      code: "const replaceModule = vi['unstable_mockModule']; replaceModule('./user-store');",
      errors: [error],
    },
    {
      name: "stable let alias",
      code: "let testApi = vi; testApi.mock('./user-store');",
      errors: [error],
    },
    {
      name: "dynamic import destructuring",
      code: "async function test() { const { vi: testApi } = await import('vitest'); const { mock } = testApi; mock('./user-store'); }",
      errors: [error],
    },
    {
      name: "arrow wrapper",
      code: "const replaceModule = (name: string) => vi.mock(name); replaceModule('./user-store');",
      errors: [error, error],
    },
    {
      name: "function wrapper",
      code: "function replaceModule(name: string) { return jest.doMock(name); } replaceModule('./user-store');",
      errors: [error, error],
    },
  ],
});
