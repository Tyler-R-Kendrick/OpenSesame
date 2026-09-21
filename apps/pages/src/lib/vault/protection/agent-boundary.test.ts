import { describe, expect, it } from "vitest";

import {
  agentMayInvokeCryptoAlias,
  assertAgentMayNotUnwrapHumanRoot,
  isRootProtectionDomain,
} from "./agent-boundary.js";
import { ProtectionError } from "./errors.js";
import { DOMAIN_CAPSULE, DOMAIN_CLOUD_WRAP } from "./limits.js";

describe("agent-boundary (KP-39)", () => {
  it("recognizes root-protection ciphertext domains", () => {
    expect(isRootProtectionDomain(DOMAIN_CAPSULE)).toBe(true);
    expect(isRootProtectionDomain(DOMAIN_CLOUD_WRAP)).toBe(true);
    expect(isRootProtectionDomain("workload/crypto/v1")).toBe(false);
  });

  it("refuses generic crypto aliases against human-vault root", () => {
    expect(
      agentMayInvokeCryptoAlias({
        alias: "Decrypt",
        purpose: "human-vault-root",
        domain: DOMAIN_CAPSULE,
      }),
    ).toBe(false);
    expect(
      agentMayInvokeCryptoAlias({
        alias: "kms:Decrypt",
        purpose: "human-vault-root",
      }),
    ).toBe(false);
    expect(
      agentMayInvokeCryptoAlias({
        alias: "age.decrypt",
        purpose: "human-vault-root",
        domain: DOMAIN_CLOUD_WRAP,
      }),
    ).toBe(false);
  });

  it("refuses generic aliases when the ciphertext domain is root-protection", () => {
    expect(
      agentMayInvokeCryptoAlias({
        alias: "Encrypt",
        purpose: "workload-root",
        domain: DOMAIN_CAPSULE,
      }),
    ).toBe(false);
  });

  it("refuses ambiguous generic aliases with no domain", () => {
    expect(
      agentMayInvokeCryptoAlias({
        alias: "unwrap",
        purpose: "workload-root",
      }),
    ).toBe(false);
  });

  it("throws agent_forbidden for ConnectionRef/MCP-style root unwrap", () => {
    expect(() =>
      assertAgentMayNotUnwrapHumanRoot({
        alias: "opensesame.vault.unwrap_root",
        purpose: "human-vault-root",
        domain: DOMAIN_CAPSULE,
      }),
    ).toThrow(ProtectionError);
    try {
      assertAgentMayNotUnwrapHumanRoot({
        alias: "Decrypt",
        purpose: "human-vault-root",
        domain: DOMAIN_CAPSULE,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProtectionError);
      if (error instanceof ProtectionError) {
        expect(error.code).toBe("agent_forbidden");
      }
    }
  });
});
