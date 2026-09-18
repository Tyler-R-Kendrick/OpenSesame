#!/usr/bin/env node
/**
 * wallet:test:protocols — live Exact EIP-3009 settlement on Anvil (WAL-E11/E13/E14).
 *
 * Starts a local chain, deploys EIP3009Mock, signs via ExactEvmScheme client,
 * settles via ExactEvmScheme facilitator, proves mismatch/replay refusals.
 * Never marks mainnet or productionEnabled.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNoMainnet } from "./lib/deny-mainnet.mjs";
import { EVIDENCE_REL, writeWalletEvidence } from "./lib/evidence.mjs";
import { isNumber, isString } from "./lib/primitive-guards.mjs";
import {
  bumpProtocolClaims,
  runMandates,
  runShippedAdapterLive,
} from "./lib/protocols-followup.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const forgeDir = join(root, "packages/wallet-x402/forge");
const home = process.env.HOME ?? "";
const foundryBins = [
  join(home, ".local/foundry"),
  join(home, ".local/foundry/bin"),
  join(home, ".config/.foundry/bin"),
  join(home, ".foundry/bin"),
];
const foundryBin = foundryBins.join(":");
const RPC_PORT = Number(process.env.WALLET_X402_ANVIL_PORT ?? "18545");
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "31337");
const NETWORK = `eip155:${CHAIN_ID}`;

/** Anvil deterministic keys (local test only; never production). */
const KEYS = {
  payer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  merchant:
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  facilitator:
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};
const MINT_AMOUNT = 1_000_000_000n; // 1000 TEST (6 decimals)
const PAY_AMOUNT = "1000000"; // 1.000000 TEST

function foundryEnv() {
  return {
    ...process.env,
    PATH: `${foundryBin}:${process.env.PATH ?? ""}`,
    CHAIN_ID: String(CHAIN_ID),
    FOUNDRY_DISABLE_NIGHTLY_WARNING: "1",
  };
}

function which(bin) {
  const r = spawnSync("bash", ["-lc", `command -v ${bin}`], {
    encoding: "utf8",
    env: foundryEnv(),
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @param {Record<string, string>} [extraEnv]
 */
function run(cmd, args, cwd, extraEnv) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...foundryEnv(), ...(extraEnv ?? {}) },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return {
    exitCode: isNumber(r.status) ? r.status : 1,
    durationMs: Date.now() - started,
    command: [cmd, ...args].join(" "),
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/**
 * @param {import('node:child_process').ChildProcess | null} child
 */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  if (child.pid) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function waitForRpc(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      if (res.ok) {
        const body = await res.json();
        if (body?.result) return body.result;
      }
    } catch {
      /* retry */
    }
    await delay(250);
  }
  throw new Error(`anvil RPC not ready at ${url}`);
}

async function main() {
  const mainnet = assertNoMainnet(process.argv.slice(2));
  if (!mainnet.ok) {
    writeWalletEvidence(root, {
      invokedAs: "pnpm wallet:test:protocols",
      mainnet: {
        ok: false,
        message: mainnet.message,
        denials: mainnet.denials,
      },
      results: [
        {
          suite: "protocols",
          status: "failed",
          exitCode: 2,
          reason: mainnet.message,
          command: null,
          durationMs: null,
        },
      ],
      ok: false,
      notes: ["Mainnet hard-deny fired before protocols harness."],
    });
    console.error(mainnet.message);
    process.exit(2);
  }

  const anvil = which("anvil");
  const forge = which("forge");
  if (!anvil || !forge) {
    writeWalletEvidence(root, {
      invokedAs: "pnpm wallet:test:protocols",
      mainnet: { ok: true, message: null, denials: [] },
      results: [
        {
          suite: "protocols",
          status: "blocked",
          exitCode: 1,
          reason: "anvil/forge missing from PATH (~/.local/foundry)",
          command: null,
          durationMs: null,
        },
      ],
      ok: false,
      notes: [
        "Install Foundry user-local; do not claim x402 local_execution_verified.",
      ],
    });
    console.error("wallet:protocols — anvil/forge required");
    process.exit(1);
  }

  /** @type {import('node:child_process').ChildProcess | null} */
  let anvilProc = null;
  /** @type {Array<{suite:string,status:string,exitCode:number|null,reason:string|null,command:string|null,durationMs:number|null,details?:Record<string,string|number|boolean|null|string[]>}>} */
  const results = [];
  let ok = true;

  try {
    // Unit fixtures first (consent + x402 pure assess)
    for (const pkg of [
      "@opensesame/wallet-x402",
      "@opensesame/wallet-consent",
    ]) {
      const unit = run("pnpm", ["--filter", pkg, "test"], root);
      results.push({
        suite: `protocols-unit-${pkg.split("/").pop()}`,
        status: unit.exitCode === 0 ? "passed" : "failed",
        exitCode: unit.exitCode,
        reason: unit.exitCode === 0 ? null : `${pkg} vitest failed`,
        command: unit.command,
        durationMs: unit.durationMs,
      });
      if (unit.exitCode !== 0) ok = false;
    }
    if (!ok) throw new Error("unit fixtures failed");

    anvilProc = spawn(
      anvil,
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(RPC_PORT),
        "--chain-id",
        String(CHAIN_ID),
        "--silent",
      ],
      {
        cwd: root,
        env: foundryEnv(),
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    await waitForRpc(RPC_URL);

    if (!existsSync(join(forgeDir, "src/EIP3009Mock.sol"))) {
      throw new Error("packages/wallet-x402/forge/src/EIP3009Mock.sol missing");
    }

    const build = run("forge", ["build", "--silent"], forgeDir);
    results.push({
      suite: "protocols-forge-build",
      status: build.exitCode === 0 ? "passed" : "failed",
      exitCode: build.exitCode,
      reason: build.exitCode === 0 ? null : "forge build failed",
      command: build.command,
      durationMs: build.durationMs,
    });
    if (build.exitCode !== 0) throw new Error("forge build failed");

    // Resolve payer address for constructor mint target via cast/viem later.
    const { createRequire } = await import("node:module");
    const pkgRequire = createRequire(
      join(root, "packages/wallet-x402/package.json"),
    );
    const resolvePkg = (specifier) =>
      pathToFileURL(pkgRequire.resolve(specifier)).href;

    const {
      createWalletClient,
      createPublicClient,
      http,
      publicActions,
      getAddress,
      parseAbi,
    } = await import(resolvePkg("viem"));
    const { privateKeyToAccount } = await import(resolvePkg("viem/accounts"));
    const { foundry } = await import(resolvePkg("viem/chains"));
    const chain = { ...foundry, id: CHAIN_ID };

    const payerAccount = privateKeyToAccount(KEYS.payer);
    const merchantAccount = privateKeyToAccount(KEYS.merchant);
    const facilitatorAccount = privateKeyToAccount(KEYS.facilitator);

    const deploy = run(
      "forge",
      [
        "create",
        "src/EIP3009Mock.sol:EIP3009Mock",
        "--broadcast",
        "--json",
        "--rpc-url",
        RPC_URL,
        "--private-key",
        KEYS.payer,
        "--constructor-args",
        payerAccount.address,
        MINT_AMOUNT.toString(),
      ],
      forgeDir,
    );
    results.push({
      suite: "protocols-deploy-eip3009",
      status: deploy.exitCode === 0 ? "passed" : "failed",
      exitCode: deploy.exitCode,
      reason: deploy.exitCode === 0 ? null : "forge create EIP3009Mock failed",
      command: "forge create …EIP3009Mock (key redacted)",
      durationMs: deploy.durationMs,
    });
    if (deploy.exitCode !== 0) throw new Error("deploy failed");

    let deployedTo = "";
    const out = `${deploy.stdout ?? ""}\n${deploy.stderr ?? ""}`;
    try {
      const start = out.indexOf("{");
      const end = out.lastIndexOf("}");
      if (start >= 0 && end > start) {
        deployedTo = JSON.parse(out.slice(start, end + 1)).deployedTo ?? "";
      }
    } catch {
      /* fall through */
    }
    if (!deployedTo) {
      const m = out.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
      deployedTo = m?.[1] ?? "";
    }
    if (!deployedTo) throw new Error("could not parse EIP3009Mock address");
    const asset = getAddress(deployedTo);

    const publicClient = createPublicClient({
      chain,
      transport: http(RPC_URL),
    });
    const facilitatorWallet = createWalletClient({
      account: facilitatorAccount,
      chain,
      transport: http(RPC_URL),
    }).extend(publicActions);

    const {
      ExactEvmScheme: ClientExact,
      toClientEvmSigner,
      toFacilitatorEvmSigner,
    } = await import(resolvePkg("@x402/evm"));
    const { ExactEvmScheme: FacilitatorExact } = await import(
      resolvePkg("@x402/evm/exact/facilitator")
    );

    const clientSigner = toClientEvmSigner(payerAccount);
    const facSigner = toFacilitatorEvmSigner(facilitatorWallet);
    const clientScheme = new ClientExact(clientSigner);
    const facScheme = new FacilitatorExact(facSigner, {
      simulateInSettle: false,
    });

    /** @type {Record<string, unknown>} */
    const requirements = {
      scheme: "exact",
      network: NETWORK,
      asset,
      amount: PAY_AMOUNT,
      payTo: getAddress(merchantAccount.address),
      maxTimeoutSeconds: 600,
      extra: {
        name: "TEST",
        version: "1",
        assetTransferMethod: "eip3009",
      },
    };

    const created = await clientScheme.createPaymentPayload(2, requirements);
    const paymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: created.payload,
    };

    const verifyOk = await facScheme.verify(paymentPayload, requirements);
    results.push({
      suite: "protocols-x402-verify",
      status: verifyOk.isValid ? "passed" : "failed",
      exitCode: verifyOk.isValid ? 0 : 1,
      reason: verifyOk.isValid
        ? null
        : `verify failed: ${verifyOk.invalidReason ?? "unknown"}`,
      command: "ExactEvmScheme.verify",
      durationMs: null,
      details: {
        asset,
        network: NETWORK,
        amount: PAY_AMOUNT,
      },
    });
    if (!verifyOk.isValid) throw new Error("verify failed");

    // WAL-E11: mutated amount must not verify
    const badReqs = { ...requirements, amount: "2000000" };
    const badPayload = {
      ...paymentPayload,
      accepted: badReqs,
    };
    const verifyBad = await facScheme.verify(badPayload, badReqs);
    const mismatchOk = verifyBad.isValid === false;
    results.push({
      suite: "protocols-WAL-E11-mismatch",
      status: mismatchOk ? "passed" : "failed",
      exitCode: mismatchOk ? 0 : 1,
      reason: mismatchOk
        ? null
        : "amount-mutated requirements incorrectly verified",
      command: "ExactEvmScheme.verify(mutated amount)",
      durationMs: null,
    });
    if (!mismatchOk) ok = false;

    const balanceAbi = parseAbi([
      "function balanceOf(address) view returns (uint256)",
    ]);
    const before = await publicClient.readContract({
      address: asset,
      abi: balanceAbi,
      functionName: "balanceOf",
      args: [merchantAccount.address],
    });

    const settle = await facScheme.settle(paymentPayload, requirements);
    const settleOk = settle.success === true && Boolean(settle.transaction);
    results.push({
      suite: "protocols-x402-settle",
      status: settleOk ? "passed" : "failed",
      exitCode: settleOk ? 0 : 1,
      reason: settleOk
        ? null
        : `settle failed: ${settle.errorReason ?? "unknown"}`,
      command: "ExactEvmScheme.settle",
      durationMs: null,
      details: {
        tx: settle.transaction ?? null,
        success: settle.success ?? false,
        errorMessage: isString(settle.errorMessage)
          ? settle.errorMessage
          : null,
      },
    });
    if (!settleOk) {
      console.error("wallet:protocols — settle detail", {
        errorReason: settle.errorReason,
        errorMessage: settle.errorMessage,
        transaction: settle.transaction,
      });
      throw new Error("settle failed");
    }

    const after = await publicClient.readContract({
      address: asset,
      abi: balanceAbi,
      functionName: "balanceOf",
      args: [merchantAccount.address],
    });
    const credited = after - before === BigInt(PAY_AMOUNT);
    results.push({
      suite: "protocols-WAL-E13-balance",
      status: credited ? "passed" : "failed",
      exitCode: credited ? 0 : 1,
      reason: credited
        ? null
        : `merchant balance delta ${after - before} != ${PAY_AMOUNT}`,
      command: "balanceOf(merchant)",
      durationMs: null,
      details: {
        before: before.toString(),
        after: after.toString(),
        tx: settle.transaction ?? null,
      },
    });
    if (!credited) ok = false;

    // WAL-E14: replay same authorization
    const replay = await facScheme.settle(paymentPayload, requirements);
    const replayRejected = replay.success === false;
    results.push({
      suite: "protocols-WAL-E14-replay",
      status: replayRejected ? "passed" : "failed",
      exitCode: replayRejected ? 0 : 1,
      reason: replayRejected
        ? null
        : "replayed authorization settled a second time",
      command: "ExactEvmScheme.settle(replay)",
      durationMs: null,
      details: {
        errorReason: replay.errorReason ?? null,
      },
    });
    if (!replayRejected) ok = false;

    const live = runShippedAdapterLive(run, {
      root,
      rpcUrl: RPC_URL,
      asset,
      payTo: merchantAccount.address,
      payerKey: KEYS.payer,
      facilitatorKey: KEYS.facilitator,
      amount: PAY_AMOUNT,
      network: NETWORK,
      chainId: CHAIN_ID,
    });
    results.push(live.result);
    if (!live.ok) ok = false;

    ok = ok && results.every((r) => r.status === "passed");
  } catch (err) {
    ok = false;
    const message = err instanceof Error ? err.message : String(err);
    results.push({
      suite: "protocols-harness",
      status: "failed",
      exitCode: 1,
      reason: message,
      command: null,
      durationMs: null,
    });
    console.error("wallet:protocols —", message);
  } finally {
    killTree(anvilProc);
    anvilProc = null;
  }

  const mandates = runMandates(run, root);
  results.push(mandates.result);
  if (!mandates.ok) ok = false;

  writeWalletEvidence(root, {
    invokedAs: "pnpm wallet:test:protocols",
    mainnet: { ok: true, message: null, denials: [] },
    results,
    ok,
    notes: [
      ok
        ? "local_execution_verified for Exact EIP-3009 on Anvil 31337 via shipped adapter; AP2/UCP ES256 fixture-local."
        : "Protocols harness failed — do not claim x402 local_execution_verified.",
      `rpc=${RPC_URL}`,
      `chainId=${CHAIN_ID}`,
      `Evidence: ${EVIDENCE_REL}`,
    ],
  });

  try {
    bumpProtocolClaims({
      root,
      ok,
      mandatesOk: mandates.ok,
      evidenceRel: EVIDENCE_REL,
    });
  } catch (err) {
    console.error("wallet:protocols — could not update claims.json", err);
  }

  if (!ok) {
    console.error(`wallet:test:protocols — FAIL. See ${EVIDENCE_REL}`);
    process.exit(1);
  }
  console.error(
    `wallet:test:protocols — PASS (local_execution_verified Exact EIP-3009). See ${EVIDENCE_REL}`,
  );
  process.exit(0);
}

await main();
