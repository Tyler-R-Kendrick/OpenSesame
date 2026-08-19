import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAtMostWins, assertSourceOrder } from "@opensesame/testing";
import { describe, expect, it } from "vitest";
import {
  NOSTR_ASSURANCE,
  assertNostrPubkey,
  createDisabledNostrAdapter,
  createNostrAdapter,
} from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const hex = "ab".repeat(32);

describe("PACT — identity-nostr", () => {
  it("property: pubkey is 64 lowercase hex, never a principal id", () => {
    expect(() => assertNostrPubkey(hex)).not.toThrow();
    expect(() => assertNostrPubkey("npub1alice")).toThrow(
      /nostr_pubkey_invalid/,
    );
    expect(() => assertNostrPubkey("prn_alice")).toThrow(
      /nostr_pubkey_invalid/,
    );
    expect(NOSTR_ASSURANCE).toBe("self_asserted");
  });

  it("adversarial: disabled verify still rejects a bad pubkey", async () => {
    const a = createDisabledNostrAdapter();
    await expect(
      a.verifySignedChallenge({
        challengeId: "c",
        pubkey: "npub1x",
        signature: "sig",
      }),
    ).rejects.toThrow(/nostr_pubkey_invalid/);
    await expect(a.createChallenge()).rejects.toThrow(/nostr_adapter_disabled/);
  });

  it("chaos: concurrent verify never succeeds", async () => {
    const a = createNostrAdapter({ OPENSESAME_NOSTR_ENABLED: "true" });
    expect(a.enabled).toBe(true);
    await assertAtMostWins(async () => {
      try {
        await a.verifySignedChallenge({
          challengeId: "c",
          pubkey: hex,
          signature: "sig",
        });
        return true;
      } catch {
        return false;
      }
    }, 0);
  });

  it("contract: factory stays disabled unless the flag is exactly true", () => {
    expect(createNostrAdapter({ OPENSESAME_NOSTR_ENABLED: "" }).enabled).toBe(
      false,
    );
    assertSourceOrder(readFileSync(join(here, "../index.ts"), "utf8"), [
      "assertNostrPubkey(input.pubkey)",
      'throw new Error("nostr_adapter_unimplemented")',
    ]);
  });
});
