import { describe, expect, it } from "vitest";
import { assertAtMostWins, assertSourceOrder } from "@opensesame/testing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATPROTO_ASSURANCE,
  assertAtprotoDid,
  createAtprotoAdapter,
  createDisabledAtprotoAdapter,
} from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("PACT — identity-atproto", () => {
  it("property: DID format is required and never treated as a principal id", () => {
    expect(() => assertAtprotoDid("did:plc:alice")).not.toThrow();
    expect(() => assertAtprotoDid("prn_alice")).toThrow(/atproto_did_invalid/);
    expect(() => assertAtprotoDid("did:plc:")).toThrow(/atproto_did_invalid/);
    expect(ATPROTO_ASSURANCE).toBe("verified");
  });

  it("adversarial: disabled adapter still rejects garbage DID", async () => {
    const a = createDisabledAtprotoAdapter();
    expect(a.enabled).toBe(false);
    await expect(a.verifySession({ did: "not-a-did" })).rejects.toThrow(
      /atproto_did_invalid/,
    );
    await expect(a.verifySession({ did: "did:plc:x" })).rejects.toThrow(
      /atproto_adapter_disabled/,
    );
  });

  it("chaos: concurrent verifySession never succeeds", async () => {
    const a = createAtprotoAdapter({ OPENSESAME_ATPROTO_ENABLED: "true" });
    expect(a.enabled).toBe(true);
    await assertAtMostWins(async () => {
      try {
        await a.verifySession({ did: "did:plc:x" });
        return true;
      } catch {
        return false;
      }
    }, 0);
  });

  it("contract: factory stays disabled unless the flag is exactly true", () => {
    expect(createAtprotoAdapter({ OPENSESAME_ATPROTO_ENABLED: "" }).enabled).toBe(
      false,
    );
    expect(createAtprotoAdapter({ OPENSESAME_ATPROTO_ENABLED: "1" }).enabled).toBe(
      false,
    );
    assertSourceOrder(readFileSync(join(here, "../index.ts"), "utf8"), [
      "assertAtprotoDid(input.did)",
      "throw new Error(\"atproto_adapter_unimplemented\")",
    ]);
  });
});
