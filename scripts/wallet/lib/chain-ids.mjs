/**
 * Hard-denied production / mainnet chain IDs for wallet BUILD gates.
 * Testnets and local forks are allowed; anything in this set fails closed.
 */

/** @type {ReadonlySet<number>} */
export const MAINNET_CHAIN_IDS = new Set([
  1, // Ethereum
  10, // Optimism
  56, // BNB Smart Chain
  100, // Gnosis
  137, // Polygon PoS
  250, // Fantom Opera
  324, // zkSync Era
  1101, // Polygon zkEVM
  8453, // Base
  42161, // Arbitrum One
  43114, // Avalanche C-Chain
  59144, // Linea
  81457, // Blast
  534352, // Scroll
  7777777, // Zora
]);

/** Env keys inspected for a configured chain id (never logged as secrets). */
export const CHAIN_ID_ENV_KEYS = [
  "CHAIN_ID",
  "WALLET_CHAIN_ID",
  "ETH_CHAIN_ID",
  "EVM_CHAIN_ID",
  "VITE_CHAIN_ID",
  "OPENSESAME_WALLET_CHAIN_ID",
];
