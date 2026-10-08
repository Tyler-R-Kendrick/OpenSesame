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
  const families = [
    ...canonicalFamilies,
    "feature-mutation",
    "feature-fuzz",
    ...(extensionMutation === "true" ? ["feature-extension"] : []),
  ];
  return {
    include: families.flatMap((family) =>
      family === "mutation-rust"
        ? [0, 1, 2, 3, 4, 5, 6, 7].map((shard) => ({
            family,
            label: `mutation-rust-${shard}of8`,
            shard,
          }))
        : [{ family, label: family }],
    ),
  };
}

if (process.argv[1]?.endsWith("/test-depth-plan.mjs")) {
  console.log(JSON.stringify(testDepthPlan(process.argv[2])));
}
