import { describe, expect, it } from "vitest";
import { parsePasswordReset } from "./password-reset-parse.js";

const flags = { json: false };
const configure = [
  "configure",
  "--config",
  "reset.json",
  "--origin",
  "https://accounts.example.test",
  "--item",
  "item-1",
  "--recipe",
  "recipe.json",
  "--transport",
  "cdp",
  "--runtime",
  "runtime.mjs",
  "--runtime-resource",
  "https://runtime.example.test",
  "--model",
  "decision-model",
  "--model-base-url",
  "https://model.example.test/v1",
  "--model-key-env",
  "RESET_MODEL_KEY",
  "--browser",
  "/opt/user/agent-browser",
];

describe("password reset grammar", () => {
  it("parses non-secret configuration and all run actions", () => {
    expect(parsePasswordReset(configure, flags)).toMatchObject({
      name: "password-reset",
      action: "configure",
      transport: "cdp",
      modelKeyEnv: "RESET_MODEL_KEY",
    });
    for (const action of ["run", "resume", "reconcile"] as const) {
      expect(
        parsePasswordReset(
          [action, "--config", "reset.json", "--run-id", "run-1"],
          flags,
        ),
      ).toMatchObject({ action, runId: "run-1" });
    }
  });

  it("refuses incomplete configure, unknown options and missing resume ids", () => {
    expect(() =>
      parsePasswordReset(["configure", "--config", "reset.json"], flags),
    ).toThrow("missing");
    expect(() =>
      parsePasswordReset([...configure, "--grants", "grants.json"], flags),
    ).toThrow();
    expect(() =>
      parsePasswordReset(["resume", "--config", "reset.json"], flags),
    ).toThrow("--run-id");
  });
});
