import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES } from "@opensesame/capability-registry";
import { describe, expect, it } from "vitest";
import { parseArgs } from "./parse.js";

const here = dirname(fileURLToPath(import.meta.url));

// Agent-surface parity pact (ADR 0065): every `surfaces.cli` command the
// registry claims for the `opensesame-id` binary must still exist in the
// argument grammar. Renaming a verb without a registry update fails here.
const grammar = [
  readFileSync(join(here, "parse.ts"), "utf8"),
  readFileSync(join(here, "run.ts"), "utf8"),
  readFileSync(join(here, "parse-retired.ts"), "utf8"),
  readFileSync(join(here, "parse-security.ts"), "utf8"),
  readFileSync(join(here, "parity-parse.ts"), "utf8"),
  readFileSync(join(here, "parity-commands.ts"), "utf8"),
  readFileSync(join(here, "parity-request.ts"), "utf8"),
]
  .join("\n")
  .toLowerCase();

function hasWord(token: string): boolean {
  const pattern = new RegExp(
    `(^|[^a-z0-9])${token.toLowerCase()}([^a-z0-9]|$)`,
  );
  return pattern.test(grammar);
}

describe("capability registry ↔ opensesame-id parity", () => {
  it.each([
    {
      id: "vaults.controlled_canaries",
      argv: ["--kind", "mcp_configuration", "--output", "private-canary.json"],
      command: "security-canary-create",
    },
    {
      id: "vaults.observation_receiver",
      argv: ["private-pairing.json", "--confirm-destination"],
      command: "security-receiver-configure",
    },
  ])("keeps $id management human-only with an executable grammar", (input) => {
    const capability = CAPABILITIES.find((entry) => entry.id === input.id);
    const command = capability?.surfaces.cli?.split(/\s+/).slice(1);
    if (!command) throw new Error("Expected a registered human ceremony.");
    expect(parseArgs([...command, ...input.argv])).toMatchObject({
      name: input.command,
    });
    for (const surface of ["mcp_host", "mcp_client", "webmcp"] as const) {
      expect(capability?.surfaces[surface]).toBeNull();
      expect(capability?.excluded?.[surface]?.adr).toBe(
        "0180-retired-credential-traps.md",
      );
    }
  });
  it("retired credential management is an executable human ceremony with no agent surface", () => {
    const capability = CAPABILITIES.find(
      (entry) => entry.id === "vaults.retired_credentials",
    );
    expect(capability?.surfaces.cli).toBe(
      "opensesame-id vault retired-credentials enroll",
    );
    const command = capability?.surfaces.cli?.split(/\s+/).slice(1);
    if (!command) throw new Error("Expected a registered human ceremony.");
    expect(() => parseArgs(command)).toThrow(
      /acknowledge-password-verifier-risk/,
    );
    expect(
      parseArgs([...command, "--acknowledge-password-verifier-risk"]),
    ).toMatchObject({ name: "vault-retired-enroll", response: "reject" });
    for (const surface of ["mcp_host", "mcp_client", "webmcp"] as const) {
      expect(capability?.surfaces[surface]).toBeNull();
      expect(capability?.excluded?.[surface]?.adr).toBe(
        "0180-retired-credential-traps.md",
      );
    }
  });
  it.each([
    {
      id: "password_provider.lease_approve",
      verb: "approve",
      argv: [
        "https://request.example",
        "--ref",
        "op://Automation/Database/password",
        "--desktop",
      ],
    },
    {
      id: "password_provider.lease_revoke",
      verb: "revoke",
      argv: ["lease-id"],
    },
  ])("keeps $id delegated to the human lease command", (input) => {
    const capability = CAPABILITIES.find((entry) => entry.id === input.id);
    const command = capability?.surfaces.cli?.split(/\s+/).slice(1);
    if (!command) throw new Error("Expected a registered lease command.");
    expect(parseArgs([...command, ...input.argv])).toMatchObject({
      name: "parity",
      verb: "lease",
      args: expect.arrayContaining([input.verb]),
    });
    for (const surface of ["mcp_host", "mcp_client", "webmcp"] as const) {
      expect(capability?.surfaces[surface]).toBeNull();
      expect(capability?.excluded?.[surface]?.reason).toContain("human CLI");
    }
  });
  it("every registered identity CLI surface exists in the grammar", () => {
    const surfaces = CAPABILITIES.map((c) => c.surfaces.cli).filter(
      (cli): cli is string => cli?.startsWith("opensesame-id ") ?? false,
    );
    expect(surfaces.length).toBeGreaterThanOrEqual(5);
    const missing: string[] = [];
    for (const surface of surfaces) {
      for (const token of surface.split(/\s+/).slice(1)) {
        if (!hasWord(token)) {
          missing.push(`${surface} → ${token}`);
        }
      }
    }
    expect(missing, missing.join("; ")).toEqual([]);
  });
});
