import model from "./extension-security-feature-vitest.mjs";

// A distinct campaign: model decisions plus genuine BrowserHost cryptography.
export default {
  ...model,
  test: {
    ...model.test,
    include: [
      ...model.test.include,
      "src/browser/security-integration/management-host.test.ts",
    ],
  },
};
