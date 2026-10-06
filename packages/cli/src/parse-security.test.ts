import { expect, it } from "vitest";
import { parseArgs } from "./parse.js";
it("parses bounded human canary and receiver commands without accepting secrets", () => {
  expect(
    parseArgs([
      "security",
      "canary",
      "create",
      "--kind",
      "mcp_configuration",
      "--output",
      "canary.json",
    ]),
  ).toMatchObject({
    name: "security-canary-create",
    kind: "mcp_configuration",
    output: "canary.json",
  });
  expect(
    parseArgs(["security", "canary", "export-mcp", "--output", "canary.json"]),
  ).toMatchObject({ name: "security-canary-export" });
  expect(
    parseArgs(["canary", "serve", "--config", "canary.json"]),
  ).toMatchObject({ name: "canary-serve", configFile: "canary.json" });
  expect(
    parseArgs([
      "security",
      "receiver",
      "configure",
      "pairing.json",
      "--confirm-destination",
    ]),
  ).toMatchObject({ name: "security-receiver-configure" });
  expect(parseArgs(["security", "receiver", "enable"])).toMatchObject({
    name: "security-receiver-enabled",
    enabled: true,
  });
});
it.each(
  [
    [
      "security",
      "canary",
      "create",
      "--kind",
      "vendor_key",
      "--output",
      "canary.json",
    ],
    [
      "security",
      "canary",
      "create",
      "--kind",
      "agent_lease",
      "--output",
      "canary.json",
      "--password",
      "secret",
    ],
    ["security", "canary", "status", "secret"],
    ["security", "receiver", "configure", "pairing.json"],
    [
      "security",
      "receiver",
      "configure",
      "pairing.json",
      "--confirm-destination",
      "secret",
    ],
    ["canary", "serve", "--token", "secret"],
    ["canary", "serve", "--config", "canary.json", "secret"],
  ].map((argv) => ({ argv })),
)("rejects unsupported or secret-bearing command arguments: %j", ({ argv }) => {
  expect(() => parseArgs(argv)).toThrow();
});
