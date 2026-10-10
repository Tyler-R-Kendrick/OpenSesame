/**
 * Wallet / spending classification entries.
 *
 * Split out of `classification-lib.ts` for the 400-line module budget.
 */

import { each, optional } from "./classification-rule.js";

const L = "src/lib/";
const WALLET = "wallet.spending";
const WALLET_FILES = ["spending-", "wallet-"];

export const WALLET_RULES = [
  ...each(L, WALLET_FILES, (p) =>
    optional(p, WALLET, "spending ledger, instruments, brokers"),
  ),
];
