import { expect, it } from "vitest";
import { TOKEN as TOKEN_PATTERN } from "./native-tailscale-api.js";
import {
  assertSyntheticTailscaleToken,
  syntheticTailscaleApiKey,
  syntheticTailscaleAuthKey,
  syntheticTailscaleClientKey,
} from "./synthetic-tailscale-key.js";

const gateHref = new URL(
  "../../../../scripts/security/tskey-literal-gate.mjs",
  import.meta.url,
).href;

it("mints synthetic Tailscale keys that satisfy the production format check", () => {
  for (const value of [
    syntheticTailscaleApiKey(),
    syntheticTailscaleClientKey(),
    syntheticTailscaleAuthKey(),
  ]) {
    assertSyntheticTailscaleToken(value);
    expect(value).toMatch(TOKEN_PATTERN);
  }
});

it("keeps Tailscale tskey literals out of tracked source, docs, and spec", async () => {
  const gate = (await import(gateHref)) as {
    findTskeyLiteralViolations: () => string[];
  };
  const violations = gate.findTskeyLiteralViolations();
  expect(violations, violations.join("\n")).toEqual([]);
});
