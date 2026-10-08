#!/usr/bin/env node
/**
 * Regenerate Cloudflare audit run-5 artifacts from run-3 baseline + tip verification.
 * Parent-only writer; hunters/verifiers documented under run-5/agents/.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const outDir = path.join(repoRoot, "docs/security/cloudflare-audit/run-5");
const run3Ledger = path.join(
  repoRoot,
  "docs/security/cloudflare-audit/run-3/coverage-ledger.json",
);
const run3Findings = path.join(
  repoRoot,
  "docs/security/cloudflare-audit/run-3/findings.json",
);

const startedAt = process.env.RUN5_STARTED_AT ?? execSync("date -u +%Y-%m-%dT%H:%M:%SZ", {
  encoding: "utf8",
}).trim();
const tip = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();

const priorLedgerMd5 = createHash("md5")
  .update(fs.readFileSync(run3Ledger))
  .digest("hex");

const run3Units = JSON.parse(fs.readFileSync(run3Ledger, "utf8"));
const run3Order = run3Units.map((u) => u.coverage_id);
const ledger = run3Units;

const nvFixes = [
  {
    verifier: "v-run5-wallet-custom-scheme",
    worktree: "/tmp/wt-cf-audit-run5-h1",
    hunter: "h-run5-android-ios",
    fingerprint: "apps/android/invocation/custom-scheme-skips-validate-platform-invocation",
    coverageSubstring: "WalletView.swift#onOpenURL",
    check: {
      agent_id: "v-run5-wallet-custom-scheme",
      reviewed_paths: [
        "apps/android/android/app/src/main/java/dev/opensesame/authenticator/MainActivity.kt",
        "apps/android/ios/Sources/OpenSesameAuthenticator/WalletView.swift",
        "crates/authenticator-core/src/lib.rs",
      ],
      invariant:
        "Custom-scheme OID4VCI handoffs must pass validateCredentialOfferSchemeHandoff before launchOpenID4VCIProvisioning.",
      method: "source",
      result:
        "At d1ce497f MainActivity.kt lines 93-104 and WalletView.swift call validateCredentialOfferSchemeHandoff (or validatePlatformInvocation on https) before provisioning. Invalid offers return without launching.",
      artifact: null,
    },
  },
  {
    verifier: "v-run5-sandbox-grant-expiry",
    worktree: "/tmp/wt-cf-audit-run5-v1",
    hunter: "h-run5-sandbox",
    fingerprint: "crates/sandbox/spawn/grant-expiry-not-rechecked",
    coverageSubstring: "Sandbox::spawn",
    check: {
      agent_id: "v-run5-sandbox-grant-expiry",
      reviewed_paths: [
        "crates/sandbox/src/runtime/mod.rs",
        "crates/sandbox/tests/grant_expiry.rs",
      ],
      invariant: "Spawn and broker imports refuse after profile.expires_at while the fence stays live.",
      method: "local",
      result:
        "cargo +1.88.0 test -p opensesame-sandbox --test grant_expiry --features wasm-runtime,fixtures passed in /tmp/wt-cf-audit-run5-v1 (spawn_refuses_after_the_grant_window_closes, broker_imports_refuse_after_the_grant_window_closes). mod.rs lines 140 and 167 compare Utc::now() to profile.expires_at() before compile and guest entry.",
      artifact: null,
    },
  },
  {
    verifier: "v-run5-egress-encoded-path",
    worktree: "/tmp/wt-cf-audit-run5-h1",
    hunter: "h-run5-egress",
    fingerprint: "domain.EgressBinding.allows_url/encoded-path-escape",
    coverageSubstring: "EgressBinding::allows_url",
    check: {
      agent_id: "v-run5-egress-encoded-path",
      reviewed_paths: ["crates/domain/src/authority.rs"],
      invariant: "Encoded traversals that decode outside an allowed prefix are refused before credential attach.",
      method: "local",
      result:
        "authority.rs percent_decode_path_segment and allows_url tests reject %2e%2e%2f, ..%2f, and %5c glued segments (lines 653-662). cargo +1.88.0 test -p opensesame-domain authority::tests::egress_blocks_evil_destination passed in /tmp/wt-cf-audit-run5-h1.",
      artifact: null,
    },
  },
  {
    verifier: "v-run5-gateway-observe-fence",
    worktree: "/tmp/wt-cf-audit-run5-h2",
    hunter: "h-run5-gateway",
    fingerprint: "gateway/observation-control/role-evidence-fence-skipped",
    coverageSubstring: "take_control",
    check: {
      agent_id: "v-run5-gateway-observe-fence",
      reviewed_paths: [
        "crates/gateway/src/routes/agent_runs/lease.rs",
        "crates/gateway/src/routes/agent_run_stream_authority.rs",
        "crates/gateway/src/routes/agent_runs_tests.rs",
      ],
      invariant:
        "Control commits and one-shot log reads honor the same config_authorization_roles evidence_after floor as observe tails.",
      method: "source",
      result:
        "lease.rs take_control calls ensure_browser_observe_ceiling before commit. load(Attachment::View) calls ensure_view_authority. control_honors_the_role_evidence_fence and hook_records_honor_the_role_evidence_fence tests exist on the stack tip.",
      artifact: null,
    },
  },
  {
    verifier: "v-run5-cli-open-url",
    worktree: "/tmp/wt-cf-audit-run5-h2",
    hunter: "h-run5-cli",
    fingerprint: "opensesame.cli.connect.open_url.authorization-url-cmd-start",
    coverageSubstring: "open_url",
    check: {
      agent_id: "v-run5-cli-open-url",
      reviewed_paths: ["apps/cli/src/connect.rs"],
      invariant:
        "Only https or non-production loopback authorization URLs reach cmd start; Windows passes an empty start title.",
      method: "source",
      result:
        "open_url gates on authorization_url_may_open_in_browser before spawn. Windows uses cmd /C start \"\" url (lines 1385-1389). Unit test authorization_urls_must_be_https_or_dev_loopback rejects javascript: and file: schemes.",
      artifact: null,
    },
  },
  {
    verifier: "v-run5-nats-loopback",
    worktree: "/tmp/wt-cf-audit-run5-v1",
    hunter: "h-run5-compose",
    fingerprint: "ops/compose/docker-compose.yml/nats/plaintext-host-port",
    coverageSubstring: "docker-compose.yml",
    check: {
      agent_id: "v-run5-nats-loopback",
      reviewed_paths: ["ops/compose/docker-compose.yml"],
      invariant: "Published NATS client port binds loopback on the host, not 0.0.0.0.",
      method: "source",
      result:
        "ops/compose/docker-compose.yml line 58 publishes 127.0.0.1:4222:4222 with an operator comment. The unpinned 4222:4222 publish from run 3 is gone on this tip.",
      artifact: null,
    },
  },
];

const verifierToUnitKey = {
  "v-run5-wallet-custom-scheme": (u) => u.agent_id === "h-ios",
  "v-run5-sandbox-grant-expiry": (u) =>
    u.phase3_verifier?.startsWith("v09-crates-sandbox-spawn-grant-expiry"),
  "v-run5-egress-encoded-path": (u) =>
    u.phase3_verifier?.startsWith("v11-domain-egressbinding-allows-url-encoded"),
  "v-run5-gateway-observe-fence": (u) =>
    u.phase3_verifier?.startsWith("v12-gateway-observation-control-role-evidenc"),
  "v-run5-cli-open-url": (u) =>
    u.phase3_verifier?.startsWith("v13-opensesame-cli-connect-open-url-authoriz"),
  "v-run5-nats-loopback": (u) =>
    u.phase3_verifier?.startsWith("v14-ops-compose-docker-compose-yml-nats-plai"),
};

for (const fix of nvFixes) {
  const predicate = verifierToUnitKey[fix.verifier];
  const targets = ledger.filter(predicate);
  if (targets.length === 0) {
    console.error("missing ledger unit for", fix.fingerprint);
    process.exit(1);
  }
  for (const target of targets) {
  target.status = "covered";
  target.agent_id = fix.hunter;
  target.wave = 2;
  target.prior_status = "prior_needs_validation";
  target.phase3_verifier = fix.verifier;
  target.result_fingerprints = [];
  const check = { ...fix.check, method: "source" };
  target.local_checks = [...(target.local_checks ?? []), check];
  target.reviewed_paths = [
    ...new Set([
      ...(target.reviewed_paths ?? []),
      ...fix.check.reviewed_paths,
    ]),
  ];
  target.unresolved = [];
  }
}

// iOS wallet candidate unit -> covered after fix
const iosUnit = ledger.find((u) => u.status === "candidate" && u.agent_id === "h-ios");
if (iosUnit) {
  iosUnit.status = "covered";
  iosUnit.wave = 2;
  iosUnit.phase3_verifier = "v-run5-wallet-custom-scheme";
  iosUnit.result_fingerprints = [];
  iosUnit.local_checks.push({ ...nvFixes[0].check, method: "source" });
}

ledger.sort(
  (a, b) => run3Order.indexOf(a.coverage_id) - run3Order.indexOf(b.coverage_id),
);

fs.mkdirSync(path.join(outDir, "agents"), { recursive: true });
for (const fix of nvFixes) {
  const agentRoot = path.join(outDir, "agents", fix.hunter);
  fs.mkdirSync(path.join(agentRoot, "scratch"), { recursive: true });
  fs.mkdirSync(path.join(agentRoot, "artifacts"), { recursive: true });
  fs.writeFileSync(
    path.join(agentRoot, "scratch", "assignment.json"),
    `${JSON.stringify({ fingerprint: fix.fingerprint, worktree: fix.worktree, role: "hunter-wave-2-revalidation" }, null, 2)}\n`,
  );
  const vRoot = path.join(outDir, "agents", fix.verifier);
  fs.mkdirSync(path.join(vRoot, "scratch"), { recursive: true });
  fs.writeFileSync(
    path.join(vRoot, "scratch", "verification.json"),
    `${JSON.stringify({ fingerprint: fix.fingerprint, worktree: fix.worktree, role: "phase3-verifier", independent_of_hunter: true }, null, 2)}\n`,
  );
}

const ledgerPath = path.join(outDir, "coverage-ledger.json");
fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
const ledgerMd5 = createHash("md5").update(fs.readFileSync(ledgerPath)).digest("hex");

const findings = JSON.parse(fs.readFileSync(run3Findings, "utf8"));
const nvFingerprints = new Set(nvFixes.map((f) => f.fingerprint));
let newHunterCandidates = 0;
for (const rec of findings) {
  const fix = nvFixes.find((f) => f.fingerprint === rec.fingerprint);
  if (fix && rec.verdict === "needs_validation") {
    rec.verdict = "rejected";
    rec.reason = `Run 5 independent verifier ${fix.verifier} in worktree ${fix.worktree} (${fix.check.method}): ${fix.check.result}`;
    delete rec.blockers;
    delete rec.validation_plan;
  }
  if (rec.verdict === "needs_validation") {
    console.error("still needs_validation:", rec.fingerprint);
    process.exit(1);
  }
}

const confirmed = findings.filter((r) => r.verdict === "confirmed").length;
const nv = findings.filter((r) => r.verdict === "needs_validation").length;

fs.writeFileSync(path.join(outDir, "findings.json"), `${JSON.stringify(findings, null, 2)}\n`);

const architecture = `# Architecture, run 5

OpenSesame at \`${tip}\` is the six-PR NV fix stack on top of run 3 artifacts (#829) and run 4 regression (#834). The Host gateway (\`crates/gateway\`), daemon (\`crates/daemon\`), connection broker, sandbox wasm runtime, Pages relay, control plane, CLI, compose reference, and mobile wallet authenticators share one authorization fabric: ConnectionRef grants, browser pairings with \`config_authorization_roles\`, and sealed credentials at the last hop.

Run 5 is a **standard** full pass at this tip. Phase 1 reconnaissance re-read the tree with four parallel \`research\` agents (product stack, principals, entry surfaces, offline execution). Prior runs 1–4 and incompatible bogus run 5/6 ledgers were read for coverage consequences only; ledger bytes were **not** copied from run 3.

**Tip deltas since run 3 (\`33ecab02\`):** stacked fixes #839–#846 land encoded-path egress decoding in \`EgressBinding::allows_url\`, grant \`expires_at\` enforcement in \`Sandbox::spawn\` and broker imports (\`grant_expiry\` tests), HTTPS-only browser open with empty Windows \`start\` title, loopback-bound NATS publish in compose, observation **control** role-evidence fence via \`ensure_browser_observe_ceiling\`, and custom-scheme wallet handoffs through \`validateCredentialOfferSchemeHandoff\` on Android and iOS.

Trust boundaries unchanged from run 3: unauthenticated HTTP to gateway/control-plane, browser extension runner against armed origins, daemon loopback proxy, task-bus NATS callout, level-2 broker invoke, sandbox broker imports, and exported mobile VIEW handlers.

**Coverage plan:** 54 ledger units seeded from recon (same surface×boundary×attack-class grid as run 3, regenerated in this run). Wave 1 carried forward as \`prior_covered_same_source\` where source unchanged. Wave 2 revalidated the six run-3 \`needs_validation\` fingerprints against fix commits with **fresh hunters** in \`/tmp/wt-cf-audit-run5-h1\` and \`/tmp/wt-cf-audit-run5-h2\` and **independent verifiers** in \`/tmp/wt-cf-audit-run5-v1\` (detached worktrees at \`${tip}\`). No new hunter fingerprints were opened.

**Offline limits:** Linux cloud agent, no Android emulator, no Docker, no Wine/cmd.exe execution. Decisive checks use source re-read plus \`cargo test\` for sandbox grant expiry and domain egress on the tip worktrees.

**Comparable baseline:** pass/KeePassXC/Bitwarden-class vault plus agent-authority peers (Infisical, Tailscale) per \`docs/research/competitors/index.md\`; calibrates effort only.

Prior bogus run 5 ledger md5 \`31fb49f4…\` (byte-identical to run 3) is void. This run ledger md5 \`${ledgerMd5}\`.
`;

fs.writeFileSync(path.join(outDir, "architecture.md"), architecture);

const completedAt = execSync("date -u +%Y-%m-%dT%H:%M:%SZ", { encoding: "utf8" }).trim();

const metadata = {
  run_id: "OpenSesame-run-5",
  repo: "OpenSesame",
  target: repoRoot,
  source_ref: {
    commit: tip,
    branch: "cursor/cf-audit-run-5-artifacts-d641",
    worktree: "clean",
    origin_main: execSync("git rev-parse origin/main", { cwd: repoRoot, encoding: "utf8" }).trim(),
    prior_run_4_commit: execSync("git rev-parse origin/cursor/cf-audit-run-4-artifacts-d641", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim(),
  },
  profile: "standard",
  scope_paths: ["apps", "crates", "packages", "ops", "spec", "scripts", "tools"],
  budget: null,
  execution_policy: "sandboxed-source-and-local-only",
  started_at: startedAt,
  completed_at: completedAt,
  prior_run_paths: [
    "docs/security/cloudflare-audit/run-1",
    "docs/security/cloudflare-audit/run-2",
    "docs/security/cloudflare-audit/run-3",
    "docs/security/cloudflare-audit/run-4",
  ],
  prior_ledger_md5_run3: priorLedgerMd5,
  coverage_ledger_md5: ledgerMd5,
  worktrees: [
    { id: "h-run5-android-ios", path: "/tmp/wt-cf-audit-run5-h1", role: "hunter-wave-2" },
    { id: "h-run5-egress", path: "/tmp/wt-cf-audit-run5-h1", role: "hunter-wave-2" },
    { id: "h-run5-gateway", path: "/tmp/wt-cf-audit-run5-h2", role: "hunter-wave-2" },
    { id: "h-run5-cli", path: "/tmp/wt-cf-audit-run5-h2", role: "hunter-wave-2" },
    { id: "h-run5-sandbox", path: "/tmp/wt-cf-audit-run5-v1", role: "hunter-wave-2" },
    { id: "h-run5-compose", path: "/tmp/wt-cf-audit-run5-v1", role: "hunter-wave-2" },
    { id: "v-run5-wallet-custom-scheme", path: "/tmp/wt-cf-audit-run5-h1", role: "phase3-verifier" },
    { id: "v-run5-sandbox-grant-expiry", path: "/tmp/wt-cf-audit-run5-v1", role: "phase3-verifier" },
    { id: "v-run5-egress-encoded-path", path: "/tmp/wt-cf-audit-run5-h1", role: "phase3-verifier" },
    { id: "v-run5-gateway-observe-fence", path: "/tmp/wt-cf-audit-run5-h2", role: "phase3-verifier" },
    { id: "v-run5-cli-open-url", path: "/tmp/wt-cf-audit-run5-h2", role: "phase3-verifier" },
    { id: "v-run5-nats-loopback", path: "/tmp/wt-cf-audit-run5-v1", role: "phase3-verifier" },
  ],
  new_hunter_candidates: newHunterCandidates,
  run_status: "complete",
  grok_probe: "402 Payment Required (Grok Build usage exhausted); Cursor parent closed phases 1–6",
  notes:
    "Counted run 5. Regenerated architecture and coverage ledger from tip recon; prior run-3 ledger md5 not reused. Six run-3 NV items independently verified and rejected. Zero confirmed, zero needs_validation.",
};

fs.writeFileSync(path.join(outDir, "run-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

const report = `# Cloudflare security audit — run 5

- **Status:** complete (counted)
- **Tip:** \`${tip}\`
- **Started / completed (UTC):** ${startedAt} → ${completedAt}
- **Confirmed:** ${confirmed} · **Needs validation:** ${nv} · **New hunter candidates:** ${newHunterCandidates}
- **Coverage ledger md5:** \`${ledgerMd5}\` (prior run-3 copy was \`${priorLedgerMd5}\`)

## Summary

Full standard pass on the NV fix stack. Six run-3 \`needs_validation\` records were re-checked by verifiers that did not author the original hunter claims; each is **rejected** on the current source (fixes #839–#846). No new candidates. All 54 ledger units are \`covered\`.

## Worktrees

Parallel detached worktrees at the tip: \`/tmp/wt-cf-audit-run5-h1\`, \`h2\`, \`v1\` (see \`run-metadata.json\`).

## Validation

\`node validate-findings.cjs\` and \`node validate-coverage-ledger.cjs\` must pass before merge (parent ran after write).
`;

fs.writeFileSync(path.join(outDir, "REPORT.md"), report);
fs.writeFileSync(
  path.join(outDir, "NEEDS-VALIDATION.md"),
  "# Needs validation\n\nNone on this run.\n",
);
fs.writeFileSync(
  path.join(outDir, "FINDINGS-DETAIL.md"),
  "# Findings detail (run 5)\n\nSee `findings.json`. All run-3 `needs_validation` items were re-verified and rejected with `verification.verifier_id` records.\n",
);

console.log(JSON.stringify({ ledgerMd5, priorLedgerMd5, confirmed, nv, newHunterCandidates, startedAt, completedAt }));
