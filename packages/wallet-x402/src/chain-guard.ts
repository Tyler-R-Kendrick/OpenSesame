/** Chain ids that must never receive a settle or funding transaction. */
export const MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, 10, 56, 137, 8453, 42161, 43114,
]);

export function isMainnetChainId(chainId: number): boolean {
  return MAINNET_CHAIN_IDS.has(chainId);
}
