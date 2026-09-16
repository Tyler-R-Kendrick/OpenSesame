/**
 * Fail closed if any configured chain id is a known mainnet.
 * Never logs secret-bearing env values — only key names and numeric chain ids.
 */

import { CHAIN_ID_ENV_KEYS, MAINNET_CHAIN_IDS } from "./chain-ids.mjs";

/**
 * @typedef {{ ok: true } | { ok: false, message: string, denials: Array<{ source: string, chainId: number }> }} MainnetCheck
 */

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {MainnetCheck}
 */
export function assertNoMainnet(
  argv = process.argv.slice(2),
  env = process.env,
) {
  /** @type {Array<{ source: string, chainId: number }>} */
  const denials = [];
  const args = argv.filter((a) => a !== "--");

  for (const key of CHAIN_ID_ENV_KEYS) {
    const raw = env[key];
    if (raw === undefined || raw === "") continue;
    const chainId = parseChainId(raw);
    if (chainId === null) {
      return {
        ok: false,
        message: `wallet: refuse — ${key} is not a numeric chain id (got non-numeric value; value not logged)`,
        denials: [],
      };
    }
    if (MAINNET_CHAIN_IDS.has(chainId)) {
      denials.push({ source: `env:${key}`, chainId });
    }
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--chain-id" || arg === "--chainId") {
      const next = args[i + 1];
      if (next === undefined) {
        return {
          ok: false,
          message: "wallet: refuse — --chain-id requires a numeric value",
          denials: [],
        };
      }
      const chainId = parseChainId(next);
      if (chainId === null) {
        return {
          ok: false,
          message:
            "wallet: refuse — --chain-id is not numeric (value not logged)",
          denials: [],
        };
      }
      if (MAINNET_CHAIN_IDS.has(chainId)) {
        denials.push({ source: "argv:--chain-id", chainId });
      }
      continue;
    }
    const eq = arg.match(/^--chain-?id=(.+)$/i);
    if (eq) {
      const chainId = parseChainId(eq[1] ?? "");
      if (chainId === null) {
        return {
          ok: false,
          message:
            "wallet: refuse — --chain-id= value is not numeric (value not logged)",
          denials: [],
        };
      }
      if (MAINNET_CHAIN_IDS.has(chainId)) {
        denials.push({ source: "argv:--chain-id", chainId });
      }
    }
  }

  if (denials.length > 0) {
    const list = denials.map((d) => `${d.source}=${d.chainId}`).join(", ");
    return {
      ok: false,
      message: `wallet: refuse — mainnet chain id hard-denied (${list}). Use a testnet/local chain id only; never mainnet or real funds.`,
      denials,
    };
  }

  return { ok: true };
}

/**
 * @param {string} raw
 * @returns {number | null}
 */
function parseChainId(raw) {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/**
 * Exit process if mainnet is configured. Returns a result object for evidence.
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv, exit?: boolean }} [opts]
 */
export function denyMainnetOrExit(opts = {}) {
  const check = assertNoMainnet(
    opts.argv ?? process.argv.slice(2),
    opts.env ?? process.env,
  );
  if (!check.ok) {
    console.error(check.message);
    if (opts.exit !== false) {
      process.exit(2);
    }
  }
  return check;
}
