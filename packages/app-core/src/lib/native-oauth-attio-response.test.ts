import { expect, it } from "vitest";
import { connectPlan } from "./connect-plan.js";
import { verifyNativeApiResponse } from "./native-api-verify.js";

it("requires Attio's actual object-list response shape for OAuth verification", () => {
  const method = connectPlan("attio")?.methods.find(
    (entry) => entry.kind === "oauth",
  );
  if (method?.kind !== "oauth") throw new Error("Attio OAuth preset required");
  const verify = method.preset?.verify;
  if (!verify) throw new Error("Attio OAuth verification contract required");
  expect(verify.requiredFields).toEqual(["data"]);
  expect(() =>
    verifyNativeApiResponse("Attio", verify, { items: [] }, {}),
  ).toThrow("Provider did not return the expected response");
  expect(() =>
    verifyNativeApiResponse("Attio", verify, { data: [] }, {}),
  ).not.toThrow();
});
