import policy from "../../../../../spec/conformance/cli-app-integration.json" with {
  type: "json",
};

export type CliAppIntegrationPolicy = typeof policy;

/** Full conformance document (tests and CLI parity); production code uses `policy-runtime.ts`. */
export const cliAppIntegrationPolicyDocument: CliAppIntegrationPolicy = policy;
