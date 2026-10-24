import { expect, it } from "vitest";
import { classify } from "./classification.js";

it("keeps the operator-supplied OIDC implementation and its tests with external connectors", () => {
  for (const suffix of [".ts", ".test.ts"])
    expect(classify(`src/lib/custom-oidc${suffix}`)).toMatchObject({
      pattern: "src/lib/custom-oidc",
      classification: "optional",
      capability: "connectors.external",
    });
  expect(classify("src/lib/custom-oidcs.ts")).toBeNull();
  expect(classify("src/lib/custom-oidcish.test.ts")).toBeNull();
  expect(
    classify("src/sections/connections/custom-oidc/CustomOidcConnector.tsx"),
  ).toMatchObject({
    classification: "optional",
    capability: "connectors.external",
  });
});
