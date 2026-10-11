import policy from "../../../../../spec/conformance/cli-app-integration.json" with {
  type: "json",
};

export type CliAppIntegrationPolicy = typeof policy;

export const cliAppIntegrationPolicy: CliAppIntegrationPolicy = policy;
