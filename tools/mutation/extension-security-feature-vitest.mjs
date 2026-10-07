import { resolve } from "node:path";
import core from "../../packages/app-core/vitest.config.ts";

// Match the sandbox working directory so instrumented modules stay in scope.
export default {
  ...core,
  root: resolve(process.cwd(), "packages/app-core"),
  test: {
    ...core.test,
    include: [
      "src/browser/security/broker.test.ts",
      "src/browser/security/client.test.ts",
      "src/browser/security/broker-authorization.test.ts",
      "src/browser/security/broker-capacity.test.ts",
      "src/browser/security/management.test.ts",
      "src/browser/security/management-revocation.test.ts",
    ],
    maxWorkers: 1,
  },
};
