/**
 * Post-Anvil follow-up for wallet:test:protocols — shipped x402 live vitest,
 * AP2/UCP fixture tests, and honest claims.json bumps.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * @typedef {(cmd: string, args: string[], cwd: string, extraEnv?: Record<string, string>) => {
 *   exitCode: number,
 *   durationMs: number,
 *   command: string,
 *   stdout: string,
 *   stderr: string,
 * }} RunFn
 */

/**
 * @param {RunFn} run
 * @param {{
 *   root: string,
 *   rpcUrl: string,
 *   asset: string,
 *   payTo: string,
 *   payerKey: string,
 *   facilitatorKey: string,
 *   amount: string,
 *   network: string,
 *   chainId: number,
 * }} input
 */
export function runShippedAdapterLive(run, input) {
  const live = run(
    "pnpm",
    [
      "--filter",
      "@opensesame/wallet-x402",
      "exec",
      "vitest",
      "run",
      "src/exact-settle.live.test.ts",
    ],
    input.root,
    {
      WALLET_X402_REQUIRE_LIVE: "1",
      WALLET_X402_RPC: input.rpcUrl,
      WALLET_X402_ASSET: input.asset,
      WALLET_X402_PAYTO: input.payTo,
      WALLET_X402_PAYER_KEY: input.payerKey,
      WALLET_X402_FACILITATOR_KEY: input.facilitatorKey,
      WALLET_X402_AMOUNT: input.amount,
      WALLET_X402_NETWORK: input.network,
      CHAIN_ID: String(input.chainId),
    },
  );
  return {
    ok: live.exitCode === 0,
    result: {
      suite: "protocols-x402-shipped-adapter",
      status: live.exitCode === 0 ? "passed" : "failed",
      exitCode: live.exitCode,
      reason:
        live.exitCode === 0
          ? null
          : "shipped prepareX402Payment/executeX402Payment live vitest failed",
      command:
        "pnpm --filter @opensesame/wallet-x402 exec vitest run src/exact-settle.live.test.ts",
      durationMs: live.durationMs,
    },
  };
}

/** @param {RunFn} run @param {string} root */
export function runMandates(run, root) {
  const mandates = run(
    "pnpm",
    ["--filter", "@opensesame/wallet-mandates", "test"],
    root,
  );
  const ok = mandates.exitCode === 0;
  return {
    ok,
    result: {
      suite: "protocols-mandates",
      status: ok ? "passed" : "failed",
      exitCode: mandates.exitCode,
      reason: ok ? null : "@opensesame/wallet-mandates vitest failed",
      command: mandates.command,
      durationMs: mandates.durationMs,
    },
  };
}

/**
 * @param {{
 *   root: string,
 *   ok: boolean,
 *   mandatesOk: boolean,
 *   evidenceRel: string,
 * }} input
 */
export function bumpProtocolClaims(input) {
  const claimsPath = join(input.root, "docs/evidence/wallet/claims.json");
  const claims = JSON.parse(readFileSync(claimsPath, "utf8"));
  claims.claims = claims.claims ?? {};
  claims.adapters = claims.adapters ?? {};
  if (input.ok) bumpX402(claims, input.evidenceRel);
  if (input.mandatesOk) bumpMandates(claims, input.evidenceRel);
  mkdirSync(dirname(claimsPath), { recursive: true });
  writeFileSync(claimsPath, `${JSON.stringify(claims, null, 2)}\n`);
}

/** @param {Record<string, unknown>} claims @param {string} evidenceRel */
function bumpX402(claims, evidenceRel) {
  const bump = {
    status: "local_execution_verified",
    productionEnabled: false,
    evidenceRefs: [
      "pnpm wallet:test:protocols",
      "packages/wallet-x402/forge/src/EIP3009Mock.sol",
      "packages/wallet-x402/src/adapter.ts",
      evidenceRel,
    ],
    profileId: "local-test.x402-exact-eip3009",
    scope: "one local anvil chain, shipped prepare/execute, EIP3009Mock",
  };
  const rows = /** @type {Record<string, unknown>} */ (claims.claims);
  rows["WAL-E11"] = {
    ...bump,
    reason:
      "Exact facilitator verify rejects amount-mutated PaymentRequirements against a payload signed for the approved amount",
  };
  rows["WAL-E13"] = {
    ...bump,
    reason:
      "Settlement success only after shipped executeX402Payment tx; merchant balance increases by approved subunits",
  };
  rows["WAL-E14"] = {
    ...bump,
    reason:
      "Replayed EIP-3009 authorization fails settle (nonce already used); no second credit",
  };
  const adapters = /** @type {Record<string, unknown>} */ (claims.adapters);
  adapters["x402-exact"] = {
    status: "local_execution_verified",
    local_execution_verified: true,
    productionEnabled: false,
    sdkPins: ["@x402/core@2.26.0", "@x402/evm@2.26.0"],
    reason:
      "Anvil Exact EIP-3009 via shipped prepareX402Payment/executeX402Payment against EIP3009Mock; productionEnabled remains false",
  };
}

/** @param {Record<string, unknown>} claims @param {string} evidenceRel */
function bumpMandates(claims, evidenceRel) {
  const bump = {
    status: "fixture_verified",
    productionEnabled: false,
    trust: "fixture-local",
    evidenceRefs: [
      "pnpm wallet:test:protocols",
      "packages/wallet-mandates",
      evidenceRel,
    ],
  };
  const rows = /** @type {Record<string, unknown>} */ (claims.claims);
  rows["WAL-B10"] = {
    ...bump,
    reason:
      "AP2/UCP ES256 local verifier accepts fixture-local checkout; alg none / issuer substitution refused. Not a public merchant.",
  };
  rows["WAL-B11"] = {
    ...bump,
    reason:
      "Constraint stripping and protection downgrade are refused; negotiated protection does not fall back to unprotected checkout.",
  };
  rows["WAL-B12"] = {
    ...bump,
    reason:
      "LocalMandateLedger refuses a second individually valid mandate that would exceed the shared remainder (700+400 against 1000).",
  };
  const adapters = /** @type {Record<string, unknown>} */ (claims.adapters);
  adapters["ap2-ucp-vi"] = {
    status: "fixture_verified",
    local_execution_verified: false,
    productionEnabled: false,
    trust: "fixture-local",
    reason:
      "ES256 fixture-local mandate crypto + stateful remainder; no independent merchant counterparty. productionEnabled remains false",
  };
}
