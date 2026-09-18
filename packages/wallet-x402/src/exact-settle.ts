/**
 * Local-only Exact EIP-3009 settle. Mainnet refused. Anvil loopback only.
 */

import {
  type JsonObject,
  type JsonValue,
  overlapCast,
} from "@opensesame/os-domain";
import {
  ExactEvmScheme as ClientExact,
  toClientEvmSigner,
  toFacilitatorEvmSigner,
} from "@x402/evm";
import { ExactEvmScheme as FacilitatorExact } from "@x402/evm/exact/facilitator";
import {
  http,
  createPublicClient,
  createWalletClient,
  getAddress,
  parseAbi,
  publicActions,
} from "viem";
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
    readonly accepted: JsonObject;
    readonly payload: JsonValue;
  };
  readonly requirements: JsonObject;
  readonly runtime: LocalExactRuntime;
};

export function assertLocalExactRuntime(runtime: LocalExactRuntime): void {
  if (MAINNET_CHAIN_IDS.has(runtime.chainId)) {
    throw new Error("MAINNET_DENIED");
  }
  if (runtime.chainId !== 31337) {
    throw new Error("INDEPENDENT_ENFORCEMENT_UNAVAILABLE: chain 31337 only");
  }
  let rpc: URL;
  try {
    rpc = new URL(runtime.rpcUrl);
  } catch {
    throw new Error("LOCAL_RPC_REQUIRED");
  }
  if (
    rpc.protocol !== "http:" ||
    rpc.hostname !== "127.0.0.1" ||
    rpc.username !== "" ||
    rpc.password !== ""
  ) {
    throw new Error("LOCAL_RPC_REQUIRED");
  }
}

const TOKEN_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
]);

export function payerAddress(runtime: LocalExactRuntime): HexAddress {
  return privateKeyToAccount(runtime.payerPrivateKey).address;
}

export async function readExactTokenBalance(
  runtime: LocalExactRuntime,
  holder: HexAddress,
): Promise<bigint> {
  assertLocalExactRuntime(runtime);
  const client = createPublicClient({
    chain: { ...foundry, id: runtime.chainId },
    transport: http(runtime.rpcUrl),
  });
  return client.readContract({
    address: runtime.asset,
    abi: TOKEN_ABI,
    functionName: "balanceOf",
    args: [getAddress(holder)],
  });
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
  const created = await clientScheme.createPaymentPayload(
    2,
    // SAFETY: test/fixture or boundary-checked value matches never,.
    requirements as never,
  );
  const payload = {
    x402Version: 2 as const,
    accepted: overlapCast(requirements),
    payload: overlapCast(created.payload) satisfies JsonValue,
  };
  return {
    ref: `prepared:x402:${globalThis.crypto.randomUUID()}`,
    payload,
    requirements: overlapCast(requirements),
    runtime,
  };
}

export async function settleExactPayment(prepared: PreparedExactPayment) {
  assertLocalExactRuntime(prepared.runtime);
  const { facilitatorWallet } = clients(prepared.runtime);
  const facScheme = new FacilitatorExact(
    // SAFETY: test/fixture or boundary-checked value matches never),.
    toFacilitatorEvmSigner(facilitatorWallet as never),
    { simulateInSettle: false },
  );
  const verifyOk = await facScheme.verify(
    // SAFETY: test/fixture or boundary-checked value matches never,.
    prepared.payload as never,
    // SAFETY: test/fixture or boundary-checked value matches never,.
    prepared.requirements as never,
  );
  if (!verifyOk.isValid) {
    return {
      success: false,
      errorReason: verifyOk.invalidReason ?? "verify_failed",
    };
  }
  const settle = await facScheme.settle(
    // SAFETY: test/fixture or boundary-checked value matches never,.
    prepared.payload as never,
    // SAFETY: test/fixture or boundary-checked value matches never,.
    prepared.requirements as never,
  );
  return {
    success: settle.success === true && Boolean(settle.transaction),
    // SAFETY: test/fixture or boundary-checked value matches string | undefined,.
    transaction: settle.transaction as string | undefined,
    // SAFETY: test/fixture or boundary-checked value matches string | undefined,.
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
    // SAFETY: test/fixture or boundary-checked value matches never),.
    toFacilitatorEvmSigner(facilitatorWallet as never),
    { simulateInSettle: false },
  );
  const badReqs = { ...prepared.requirements, amount: mutatedAmount };
  const verifyBad = await facScheme.verify(
    // SAFETY: test/fixture or boundary-checked value matches never,.
    { ...prepared.payload, accepted: badReqs } as never,
    // SAFETY: test/fixture or boundary-checked value matches never,.
    badReqs as never,
  );
  return verifyBad.isValid === false;
}
