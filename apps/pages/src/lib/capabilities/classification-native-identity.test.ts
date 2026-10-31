import { expect, it } from "vitest";
import { classify } from "./classification.js";

it("owns the common native identity admission family under the core sign-in road", () => {
  for (const path of [
    "src/lib/native-identity-admission.ts",
    "src/lib/native-identity-admission.test.ts",
  ])
    expect(classify(path), path).toMatchObject({
      pattern: "src/lib/native-identity-admission",
      classification: "core",
      capability: "identity.brokered-signin",
    });
  for (const path of [
    "src/lib/native-identity-admissions.ts",
    "src/lib/native-identity-admit.ts",
    "src/lib/native-identity-admissionary.ts",
  ])
    expect(classify(path), path).toMatchObject({
      pattern: "src/lib/native-",
      classification: "optional",
      capability: "connectors.external",
    });
});
