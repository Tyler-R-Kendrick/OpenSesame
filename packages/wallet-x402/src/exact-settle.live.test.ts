import { describe, expect, it } from "vitest";
import {
  executeX402Payment,
  prepareX402Payment,
  refuseMutatedExactAmount,
} from "./adapter.js";
import type { LocalExactRuntime } from "./exact-settle.js";

function runtimeFromEnv(): LocalExactRuntime | null {
  const rpcUrl = process.env.WALLET_X402_RPC;
  const asset = process.env.WALLET_X402_ASSET;
  const payTo = process.env.WALLET_X402_PAYTO;
  const payer = process.env.WALLET_X402_PAYER_KEY;
  const facilitator = process.env.WALLET_X402_FACILITATOR_KEY;
  if (!rpcUrl || !asset || !payTo || !payer || !facilitator) return null;
  const network = process.env.WALLET_X402_NETWORK ?? "eip155:31337";
  const colon = network.indexOf(":");
  if (colon <= 0 || colon === network.length - 1) return null;
  return {
    rpcUrl,
    chainId: Number(process.env.CHAIN_ID ?? "31337"),
    payerPrivateKey: payer as `0x${string}`,
    facilitatorPrivateKey: facilitator as `0x${string}`,
    asset: asset as `0x${string}`,
    payTo: payTo as `0x${string}`,
    amount: process.env.WALLET_X402_AMOUNT ?? "1000000",
    network: network as `${string}:${string}`,
  };
}

describe("x402 exact live settle", () => {
  it("settles through shipped prepare/execute", async () => {
    const runtime = runtimeFromEnv();
    if (runtime === null) {
      if (process.env.WALLET_X402_REQUIRE_LIVE === "1") {
        throw new Error("WALLET_X402_REQUIRE_LIVE=1 but Anvil env missing");
      }
      return;
    }
    const prepared = await prepareX402Payment({ runtime });
    expect(await refuseMutatedExactAmount(prepared.ref, "2000000")).toBe(true);
    const executed = await executeX402Payment({ preparedRef: prepared.ref });
    expect(executed.status).toBe("confirmed");
    expect(executed.transaction).toMatch(/^0x[0-9a-fA-F]+$/);
    const replay = await executeX402Payment({ preparedRef: prepared.ref });
    expect(replay.status).toBe("failed");
  });
});
