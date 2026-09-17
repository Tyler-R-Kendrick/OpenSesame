import { describe, expect, it } from "vitest";
import { MAINNET_CHAIN_IDS, isMainnetChainId } from "./chain-guard.js";

describe("chain-guard", () => {
  it("treats Ethereum and common L2s as mainnet", () => {
    expect(isMainnetChainId(1)).toBe(true);
    expect(isMainnetChainId(31337)).toBe(false);
    expect(MAINNET_CHAIN_IDS.has(31337)).toBe(false);
  });
});
