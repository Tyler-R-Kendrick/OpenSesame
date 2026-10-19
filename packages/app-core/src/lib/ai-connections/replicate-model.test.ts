import { expect, it } from "vitest";
import { replicatePredictionTarget } from "./replicate-types.js";
it("shares the real owner/model/version path contract between configuration and prediction creation", () => {
  const version = "a".repeat(64);
  expect(replicatePredictionTarget("owner/model")).toEqual({
    path: "models/owner/model/predictions",
  });
  expect(replicatePredictionTarget(version)).toEqual({
    path: "predictions",
    version,
  });
  expect(replicatePredictionTarget(`owner/model:${version}`)).toEqual({
    path: "predictions",
    version,
  });
});
it.each([
  "",
  "owner",
  "owner/../other",
  "../model",
  "https://evil.example/model",
  "owner/model?token=x",
  "owner/model#fragment",
  "owner/model:short",
])(
  "refuses a model target outside the closed prediction path grammar: %s",
  (model) => {
    expect(() => replicatePredictionTarget(model)).toThrow("Replicate");
  },
);
