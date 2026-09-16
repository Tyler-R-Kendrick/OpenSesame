import { describe, expect, it } from "vitest";
import { assertNoMainnet } from "./deny-mainnet.mjs";

describe("assertNoMainnet (WAL-B14)", () => {
  it("allows local anvil chain id 31337", () => {
    expect(assertNoMainnet([], { CHAIN_ID: "31337" })).toEqual({ ok: true });
  });

  it("refuses ethereum mainnet env and argv", () => {
    const env = assertNoMainnet([], { CHAIN_ID: "1" });
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.message).toMatch(/mainnet chain id hard-denied/);
      expect(env.denials.some((d) => d.chainId === 1)).toBe(true);
    }
    const argv = assertNoMainnet(["--chain-id", "1"], { CHAIN_ID: "31337" });
    expect(argv.ok).toBe(false);
  });

  it("does not auto-activate when source says mainnet (no silent ok)", () => {
    const check = assertNoMainnet(["--chain-id=1"], {});
    expect(check.ok).toBe(false);
  });
});
