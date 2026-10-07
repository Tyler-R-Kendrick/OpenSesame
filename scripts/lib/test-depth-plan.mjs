export const canonicalFamilies = [
  "verify",
  "coverage-ts",
  "coverage-rust",
  "scans",
  "mutation-ts",
  "mutation-rust",
  "fuzz-ts",
  "fuzz-rust",
];

export function testDepthPlan(extensionMutation) {
  if (!["true", "false"].includes(extensionMutation)) {
    throw new Error("Expected explicit extension mutation boolean");
  }
  return {
    family: [
      ...canonicalFamilies,
      "feature-mutation",
      "feature-fuzz",
      ...(extensionMutation === "true" ? ["feature-extension"] : []),
    ],
  };
}

if (process.argv[1]?.endsWith("/test-depth-plan.mjs")) {
  console.log(JSON.stringify(testDepthPlan(process.argv[2])));
}
