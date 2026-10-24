/** Per-invocation wallet results: source obligations never inherit old passes. */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const RUN_ENV = "OPENSESAME_WALLET_RUN_ID";
const CLAIMS = "work/evidence/wallet/wallet/cross-platform/claims.json";

function source(root) {
  const seed = readFileSync(join(root, "spec/conformance/wallet-claims.json"));
  const git = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (git.status !== 0)
    throw new Error("wallet claims require an existing source commit");
  return {
    seed,
    head: git.stdout.trim(),
    seedSha256: createHash("sha256").update(seed).digest("hex"),
  };
}

/** An orchestrator always starts here, even for dry runs or denied requests. */
export function startWalletVerification(root) {
  const current = source(root);
  const claims = JSON.parse(current.seed);
  claims.verificationRun = {
    version: 1,
    id: randomUUID(),
    head: current.head,
    seedSha256: current.seedSha256,
  };
  const file = join(root, CLAIMS);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(claims, null, 2)}\n`);
  process.env[RUN_ENV] = claims.verificationRun.id;
  return claims;
}

/** Standalone invocations reset; child suites may share only their parent's run. */
export function initializeWalletVerification(root) {
  return process.env[RUN_ENV]
    ? readWalletClaims(root)
    : startWalletVerification(root);
}

/** Refuse old results after a new invocation, checkout, or obligation change. */
export function readWalletClaims(root) {
  if (!process.env[RUN_ENV]) return startWalletVerification(root);
  const current = source(root);
  const claims = JSON.parse(readFileSync(join(root, CLAIMS), "utf8"));
  const run = claims.verificationRun;
  if (
    run?.version !== 1 ||
    run.id !== process.env[RUN_ENV] ||
    run.head !== current.head ||
    run.seedSha256 !== current.seedSha256
  ) {
    throw new Error(
      "stale wallet claims: restart wallet verification for this source and seed",
    );
  }
  return claims;
}
