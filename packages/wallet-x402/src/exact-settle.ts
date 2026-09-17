/**
 * Local-only Exact EIP-3009 settle. Mainnet refused. Anvil loopback only.
 */

import {
  ExactEvmScheme as ClientExact,
  toClientEvmSigner,
  toFacilitatorEvmSigner,
} from "@x402/evm";
import { ExactEvmScheme as FacilitatorExact } from "@x402/evm/exact/facilitator";
import { createWalletClient, getAddress, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { MAINNET_CHAIN_IDS } from "./chain-guard.js";

export type HexKey = `0x${string}`;
export type HexAddress = `0x${string}`;

export type LocalExactRuntime = {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly payerPrivateKey: HexKey;
  readonly facilitatorPrivateKey: HexKey;
  readonly asset: HexAddress;
  readonly payTo: HexAddress;
  readonly amount: string;
  readonly network: `${string}:${string}`;
};

export type PreparedExactPayment = {
  readonly ref: string;
  readonly payload: {
    readonly x402Version: 2;
    readonly accepted: Record<string, unknown>;
    readonly payload: unknown;
  };
  readonly requirements: Record<string, unknown>;
  readonly runtime: LocalExactRuntime;
};

export function assertLocalExactRuntime(runtime: LocalExactRuntime): void {
  if (MAINNET_CHAIN_IDS.has(runtime.chainId)) {
    throw new Error("MAINNET_DENIED");
  }
  if (runtime.chainId !== 31337) {
    throw new Error("INDEPENDENT_ENFORCEMENT_UNAVAILABLE: chain 31337 only");
  }
  if (!runtime.rpcUrl.startsWith("http://127.0.0.1:")) {
    throw new Error("LOCAL_RPC_REQUIRED");
  }
}

function clients(runtime: LocalExactRuntime) {
  const chain = { ...foundry, id: runtime.chainId };
  const payer = privateKeyToAccount(runtime.payerPrivateKey);
  const facilitator = privateKeyToAccount(runtime.facilitatorPrivateKey);
  const facilitatorWallet = createWalletClient({
    account: facilitator,
    chain,
    transport: http(runtime.rpcUrl),
  }).extend(publicActions);
  return { payer, facilitatorWallet };
}

export async function createExactPaymentPayload(
  runtime: LocalExactRuntime,
): Promise<PreparedExactPayment> {
  assertLocalExactRuntime(runtime);
  const { payer } = clients(runtime);
  const clientScheme = new ClientExact(toClientEvmSigner(payer));
  const requirements = {
    scheme: "exact",
    network: runtime.network,
    asset: getAddress(runtime.asset),
    amount: runtime.amount,
    payTo: getAddress(runtime.payTo),
    maxTimeoutSeconds: 600,
    extra: { name: "TEST", version: "1", assetTransferMethod: "eip3009" },
  };
  const created = await clientScheme.createPaymentPayload(2, requirements as never);
  const payload = {
    x402Version: 2 as const,
    accepted: requirements,
    payload: created.payload,
  };
  return {
    ref: `prepared:x402:${runtime.amount}`,
    payload,
    requirements,
    runtime,
  };
}

export async function settleExactPayment(prepared: PreparedExactPayment) {
  assertLocalExactRuntime(prepared.runtime);
  const { facilitatorWallet } = clients(prepared.runtime);
  const facScheme = new FacilitatorExact(
    toFacilitatorEvmSigner(facilitatorWallet as never),
    { simulateInSettle: false },
  );
  const verifyOk = await facScheme.verify(
    prepared.payload as never,
    prepared.requirements as never,
  );
  if (!verifyOk.isValid) {
    return { success: false, errorReason: verifyOk.invalidReason ?? "verify_failed" };
  }
  const settle = await facScheme.settle(
    prepared.payload as never,
    prepared.requirements as never,
  );
  return {
    success: settle.success === true && Boolean(settle.transaction),
    transaction: settle.transaction as string | undefined,
    errorReason: settle.errorReason as string | undefined,
  };
}

export async function verifyExactPaymentMismatch(
  prepared: PreparedExactPayment,
  mutatedAmount: string,
): Promise<boolean> {
  assertLocalExactRuntime(prepared.runtime);
  const { facilitatorWallet } = clients(prepared.runtime);
  const facScheme = new FacilitatorExact(
    toFacilitatorEvmSigner(facilitatorWallet as never),
    { simulateInSettle: false },
  );
  const badReqs = { ...prepared.requirements, amount: mutatedAmount };
  const verifyBad = await facScheme.verify(
    { ...prepared.payload, accepted: badReqs } as never,
    badReqs as never,
  );
  return verifyBad.isValid === false;
}
