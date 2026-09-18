#!/usr/bin/env node
/**
 * wallet:test:contracts — Foundry/Anvil local-chain evidence (WAL-E*).
 *
 * Ensures:
 *   - forge/anvil on PATH (defaults to ~/.local/foundry)
 *   - MetaMask delegation-framework vendor at pin bff4b08
 *   - OpenSesame SiblingSharedPeriodCap tests + upstream period suite
 *
 * Fail-closed if forge missing or tests fail. Never marks mainnet.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isNumber } from "./lib/primitive-guards.mjs";

import { assertNoMainnet } from "./lib/deny-mainnet.mjs";
import { EVIDENCE_REL, writeWalletEvidence } from "./lib/evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PIN = "bff4b08f8006ad94322a6e3da8d90f274e20325d";
const vendorDir = join(root, "packages/wallet-evm/vendor/delegation-framework");
const forgeTestSrc = join(
  root,
  "packages/wallet-evm/forge/test/SiblingSharedPeriodCap.t.sol",
);
const forgeTestDst = join(
  vendorDir,
  "test/opensesame/SiblingSharedPeriodCap.t.sol",
);
const forgeE05Src = join(
  root,
  "packages/wallet-evm/forge/test/WalE05RecipientAndValue.t.sol",
);
const forgeE05Dst = join(
  vendorDir,
  "test/opensesame/WalE05RecipientAndValue.t.sol",
);
const forgeE0609Src = join(
  root,
  "packages/wallet-evm/forge/test/WalE06E09MethodAndExpiry.t.sol",
);
const forgeE0609Dst = join(
  vendorDir,
  "test/opensesame/WalE06E09MethodAndExpiry.t.sol",
);
const forgeE04Src = join(
  root,
  "packages/wallet-evm/forge/test/WalE04MixedAssetCaveat.t.sol",
);
const forgeE04Dst = join(
  vendorDir,
  "test/opensesame/WalE04MixedAssetCaveat.t.sol",
);
const home = process.env.HOME ?? "";
const foundryBins = [
  join(home, ".local/foundry"),
  join(home, ".local/foundry/bin"),
  join(home, ".config/.foundry/bin"),
  join(home, ".foundry/bin"),
];

function foundryEnv() {
  const path = `${foundryBins.join(":")}:${process.env.PATH ?? ""}`;
  return {
    ...process.env,
    PATH: path,
    CHAIN_ID: process.env.CHAIN_ID ?? "31337",
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

function run(cmd, args, cwd) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: foundryEnv(),
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return {
    exitCode: isNumber(r.status) ? r.status : 1,
    durationMs: Date.now() - started,
    command: [cmd, ...args].join(" "),
  };
}

function ensureVendor() {
  if (existsSync(join(vendorDir, "src/DelegationManager.sol"))) {
    const head = spawnSync("git", ["-C", vendorDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    const sha = (head.stdout ?? "").trim();
    if (sha !== PIN) {
      console.error(
        `wallet:contracts — vendor HEAD ${sha} != required pin ${PIN}`,
      );
      return false;
    }
    return true;
  }
  mkdirSync(dirname(vendorDir), { recursive: true });
  console.error("wallet:contracts — cloning delegation-framework @", PIN);
  const clone = run(
    "git",
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "https://github.com/MetaMask/delegation-framework.git",
      vendorDir,
    ],
    root,
  );
  if (clone.exitCode !== 0) return false;
  const fetch = run("git", ["fetch", "--depth", "1", "origin", PIN], vendorDir);
  if (fetch.exitCode !== 0) return false;
  const co = run("git", ["checkout", PIN], vendorDir);
  if (co.exitCode !== 0) return false;
  const sub = run(
    "git",
    ["submodule", "update", "--init", "--recursive"],
    vendorDir,
  );
  return sub.exitCode === 0;
}

const mainnet = assertNoMainnet(process.argv.slice(2));
if (!mainnet.ok) {
  writeWalletEvidence(root, {
    invokedAs: "pnpm wallet:test:contracts",
    mainnet: {
      ok: false,
      message: mainnet.message,
      denials: mainnet.denials,
    },
    results: [
      {
        suite: "contracts",
        status: "failed",
        exitCode: 2,
        reason: mainnet.message,
        command: null,
        durationMs: null,
      },
    ],
    ok: false,
    notes: ["Mainnet hard-deny fired before contracts harness."],
  });
  console.error(mainnet.message);
  process.exit(2);
}

const forge = which("forge");
const anvil = which("anvil");
if (!forge || !anvil) {
  writeWalletEvidence(root, {
    invokedAs: "pnpm wallet:test:contracts",
    mainnet: { ok: true, message: null, denials: [] },
    results: [
      {
        suite: "contracts",
        status: "failed",
        exitCode: 1,
        reason:
          "forge/anvil not found; install Foundry under ~/.config/.foundry/bin or ~/.local/foundry (foundryup / release tarball, not sudo)",
        command: null,
        durationMs: null,
      },
    ],
    ok: false,
    notes: [
      `forge=${forge ?? "missing"} anvil=${anvil ?? "missing"}`,
      `Expected PATH prefixes: ${foundryBins.join(":")}`,
    ],
  });
  console.error("wallet:contracts — forge/anvil missing");
  process.exit(1);
}

if (!ensureVendor()) {
  writeWalletEvidence(root, {
    invokedAs: "pnpm wallet:test:contracts",
    mainnet: { ok: true, message: null, denials: [] },
    results: [
      {
        suite: "contracts",
        status: "failed",
        exitCode: 1,
        reason: "failed to prepare delegation-framework vendor at pin",
        command: null,
        durationMs: null,
      },
    ],
    ok: false,
    notes: [`pin=${PIN}`],
  });
  process.exit(1);
}

if (!existsSync(forgeTestSrc)) {
  console.error("wallet:contracts — missing", forgeTestSrc);
  process.exit(1);
}
mkdirSync(dirname(forgeTestDst), { recursive: true });
copyFileSync(forgeTestSrc, forgeTestDst);
if (!existsSync(forgeE05Src)) {
  console.error("wallet:contracts — missing", forgeE05Src);
  process.exit(1);
}
copyFileSync(forgeE05Src, forgeE05Dst);
if (!existsSync(forgeE0609Src)) {
  console.error("wallet:contracts — missing", forgeE0609Src);
  process.exit(1);
}
copyFileSync(forgeE0609Src, forgeE0609Dst);
if (!existsSync(forgeE04Src)) {
  console.error("wallet:contracts — missing", forgeE04Src);
  process.exit(1);
}
copyFileSync(forgeE04Src, forgeE04Dst);

const results = [];
const unit = run("pnpm", ["--filter", "@opensesame/wallet-evm", "test"], root);
results.push({
  suite: "contracts-unit-simulation",
  status: unit.exitCode === 0 ? "passed" : "failed",
  exitCode: unit.exitCode,
  reason: unit.exitCode === 0 ? null : "wallet-evm vitest failed",
  command: unit.command,
  durationMs: unit.durationMs,
});

const forgeOpensesame = run(
  "forge",
  ["test", "--match-contract", "SiblingSharedPeriodCapTest", "-vv"],
  vendorDir,
);
results.push({
  suite: "contracts-forge-opensesame",
  status: forgeOpensesame.exitCode === 0 ? "passed" : "failed",
  exitCode: forgeOpensesame.exitCode,
  reason:
    forgeOpensesame.exitCode === 0 ? null : "SiblingSharedPeriodCapTest failed",
  command: forgeOpensesame.command,
  durationMs: forgeOpensesame.durationMs,
});

const forgeUpstream = run(
  "forge",
  ["test", "--match-contract", "ERC20PeriodTransferEnforcerTest", "-vv"],
  vendorDir,
);
results.push({
  suite: "contracts-forge-upstream-period",
  status: forgeUpstream.exitCode === 0 ? "passed" : "failed",
  exitCode: forgeUpstream.exitCode,
  reason:
    forgeUpstream.exitCode === 0
      ? null
      : "ERC20PeriodTransferEnforcerTest failed",
  command: forgeUpstream.command,
  durationMs: forgeUpstream.durationMs,
});

const forgeE05 = run(
  "forge",
  ["test", "--match-contract", "WalE05RecipientAndValueTest", "-vv"],
  vendorDir,
);
results.push({
  suite: "contracts-forge-wal-e05",
  status: forgeE05.exitCode === 0 ? "passed" : "failed",
  exitCode: forgeE05.exitCode,
  reason: forgeE05.exitCode === 0 ? null : "WalE05RecipientAndValueTest failed",
  command: forgeE05.command,
  durationMs: forgeE05.durationMs,
});

const forgeE0609 = run(
  "forge",
  ["test", "--match-contract", "WalE06E09MethodAndExpiryTest", "-vv"],
  vendorDir,
);
results.push({
  suite: "contracts-forge-wal-e06-e09",
  status: forgeE0609.exitCode === 0 ? "passed" : "failed",
  exitCode: forgeE0609.exitCode,
  reason:
    forgeE0609.exitCode === 0 ? null : "WalE06E09MethodAndExpiryTest failed",
  command: forgeE0609.command,
  durationMs: forgeE0609.durationMs,
});

const forgeE04 = run(
  "forge",
  ["test", "--match-contract", "WalE04MixedAssetCaveatTest", "-vv"],
  vendorDir,
);
results.push({
  suite: "contracts-forge-wal-e04",
  status: forgeE04.exitCode === 0 ? "passed" : "failed",
  exitCode: forgeE04.exitCode,
  reason: forgeE04.exitCode === 0 ? null : "WalE04MixedAssetCaveatTest failed",
  command: forgeE04.command,
  durationMs: forgeE04.durationMs,
});

const ok = results.every((r) => r.status === "passed");
const evidenceExtra = {
  forgeVersion: run("forge", ["--version"], root),
  anvilVersion: run("anvil", ["--version"], root),
  pin: PIN,
  chainId: process.env.CHAIN_ID ?? "31337",
};

writeWalletEvidence(root, {
  invokedAs: "pnpm wallet:test:contracts",
  mainnet: { ok: true, message: null, denials: [] },
  results,
  ok,
  notes: [
    ok
      ? "local_execution_verified for ERC20PeriodTransferEnforcer shared-parent amount/period on pin bff4b08 (chainId 31337 / forge)."
      : "Contracts harness failed — do not claim local_execution_verified.",
    `pin=${PIN}`,
    `forge=${forge}`,
    `anvil=${anvil}`,
    `Evidence: ${EVIDENCE_REL}`,
    JSON.stringify({
      forge: (evidenceExtra.forgeVersion.stdout ?? "").split("\n")[0],
      anvil: (evidenceExtra.anvilVersion.stdout ?? "").split("\n")[0],
    }),
  ],
});

// Machine-readable claim bump when green
if (ok) {
  const claimsPath = join(root, "docs/evidence/wallet/claims.json");
  try {
    const claims = JSON.parse(readFileSync(claimsPath, "utf8"));
    claims.claims = claims.claims ?? {};
    for (const id of ["WAL-E01", "WAL-E02", "WAL-E03"]) {
      claims.claims[id] = {
        status: "local_execution_verified",
        reason:
          "forge SiblingSharedPeriodCapTest + ERC20PeriodTransferEnforcerTest against MetaMask pin bff4b08; shared parent hash enforces aggregate; substituted independent roots (WAL-E03) do not inherit the approved counter",
        productionEnabled: false,
        evidenceRefs: [
          "pnpm wallet:test:contracts",
          "packages/wallet-evm/forge/test/SiblingSharedPeriodCap.t.sol",
          EVIDENCE_REL,
        ],
        profileId: "local-test.direct-erc20-period-delegation",
        scope:
          "one local forge chain, ERC20PeriodTransferEnforcer, shared parent delegationHash",
      };
    }
    claims.claims["WAL-E06"] = {
      status: "local_execution_verified",
      reason:
        "forge WalE06E09MethodAndExpiryTest + upstream invalid-method: approve/transferFrom rejected by ERC20PeriodTransferEnforcer",
      productionEnabled: false,
      evidenceRefs: [
        "pnpm wallet:test:contracts",
        "packages/wallet-evm/forge/test/WalE06E09MethodAndExpiry.t.sol",
        EVIDENCE_REL,
      ],
      profileId: "local-test.direct-erc20-period-delegation",
      scope:
        "ERC20PeriodTransferEnforcer method allowlist on local forge chain",
    };
    claims.claims["WAL-E09"] = {
      status: "local_execution_verified",
      reason:
        "forge WalE06E09MethodAndExpiryTest: TimestampEnforcer refuses execution after validUntil (expired-delegation)",
      productionEnabled: false,
      evidenceRefs: [
        "pnpm wallet:test:contracts",
        "packages/wallet-evm/forge/test/WalE06E09MethodAndExpiry.t.sol",
        EVIDENCE_REL,
      ],
      profileId: "local-test.direct-erc20-period-delegation",
      scope: "TimestampEnforcer validUntil on local forge chain",
    };
    claims.claims["WAL-E05"] = {
      status: "local_execution_verified",
      reason:
        "forge WalE05RecipientAndValueTest: ExactCalldataEnforcer rejects alternate transfer recipient; ValueLteEnforcer(0) rejects nonzero native value with token calldata",
      productionEnabled: false,
      evidenceRefs: [
        "pnpm wallet:test:contracts",
        "packages/wallet-evm/forge/test/WalE05RecipientAndValue.t.sol",
        EVIDENCE_REL,
      ],
      profileId: "local-test.direct-erc20-period-delegation",
      scope: "ExactCalldataEnforcer + ValueLteEnforcer on local forge chain",
    };
    claims.claims["WAL-E04"] = {
      status: "local_execution_verified",
      reason:
        "forge WalE04MixedAssetCaveatTest: ERC20PeriodTransferEnforcer keyed only by delegationHash shares period counter across mixed token terms and duplicate caveats — activation must refuse mixed-asset composition; harness proves shared-key hazard + single-hash aggregate",
      productionEnabled: false,
      evidenceRefs: [
        "pnpm wallet:test:contracts",
        "packages/wallet-evm/forge/test/WalE04MixedAssetCaveat.t.sol",
        EVIDENCE_REL,
      ],
      profileId: "local-test.direct-erc20-period-delegation",
      scope: "mixed-asset / duplicate period caveats on shared delegationHash",
    };
    claims.adapters = claims.adapters ?? {};
    claims.adapters.directErc20Delegation = {
      status: "local_execution_verified",
      local_execution_verified: true,
      productionEnabled: false,
      sourceCommit: PIN,
      reason:
        "Foundry tests exercised real enforcer + DelegationManager paths; productionEnabled remains false (no target deployment)",
    };
    writeFileSync(claimsPath, `${JSON.stringify(claims, null, 2)}\n`);
  } catch (err) {
    console.error("wallet:contracts — could not update claims.json", err);
  }
}

if (!ok) {
  console.error(`wallet:test:contracts — FAIL. See ${EVIDENCE_REL}`);
  process.exit(1);
}
console.error(
  `wallet:test:contracts — PASS (local_execution_verified period/amount). See ${EVIDENCE_REL}`,
);
