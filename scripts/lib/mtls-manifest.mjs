#!/usr/bin/env node
/**
 * mTLS evidence manifest writer — artifacts/mtls/manifest.json + manifest.md.
 *
 * The shell runners (scripts/mtls-test.sh, mtls-integration-test.sh) drive it:
 *
 *   begin     --run <dir> --suite <name>              start a run (versions, commit, tree)
 *   run-step  --run <dir> --id <step> --claim <id> [--scenarios A,B] [--runner cargo|vitest|marker|shell]
 *             [--required true|false] [--timeout <s>] [--profile <p>] [--target <t>] [--paths a,b]
 *             [--expected ..] [--observed-pass ..] [--observed-fail ..] [--coverage-limit ..]
 *             [--skip <reason>] [--unsupported <reason>] -- <command...>
 *   finish    --run <dir>                              write manifest.json/.md; exit 1 if a required step is not passed
 *   summarize [manifest.json ...]                      markdown table (docs/validation/mtls-implementation.md)
 *   sanitize  <in> <out>                               redact a captured log
 *
 * Every step records claim_id, scenario_ids, source_commit, tested_tree,
 * implementation_paths, transport_profile, execution_target, command,
 * exit_code, result ∈ {passed, failed, not_executed, unsupported}, expected,
 * observed, artifacts (sanitized log path + sha256), coverage_limit and
 * duration_ms. A required step that ran nothing is `failed`, never `passed`.
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown, summarizeRows } from "./mtls-manifest-render.mjs";
import { sanitize } from "./mtls-sanitize.mjs";
import {
  judge,
  parseTestCounts,
  runBounded,
  sha256Hex,
} from "./mtls-step-runner.mjs";
import { collectVersions } from "./mtls-versions.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESULTS = new Set(["passed", "failed", "not_executed", "unsupported"]);

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/** sha256(`git diff HEAD` + `git status --porcelain`): the tree actually tested. */
export function testedTree() {
  const diff = git([
    "diff",
    "HEAD",
    "--",
    ".",
    ":(exclude).cache",
    ":(exclude)artifacts",
  ]);
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean)
    .map((f) => {
      try {
        return `${f} ${git(["hash-object", "--", f]).trim()}`;
      } catch {
        return `${f} unreadable`;
      }
    })
    .join("\n");
  return {
    source_commit: git(["rev-parse", "HEAD"]).trim(),
    tested_tree: sha256Hex(`${diff}\n${status}`),
    untracked_blobs: sha256Hex(untracked),
    dirty: status.trim().length > 0,
  };
}

function parseArgs(argv) {
  const opts = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") return { opts, command: argv.slice(i + 1) };
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-/g, "_");
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--") || next === "--") {
        opts[key] = true;
        i += 1;
      } else {
        opts[key] = next;
        i += 2;
      }
    } else {
      opts._ = opts._ ?? [];
      opts._.push(a);
      i += 1;
    }
  }
  return { opts, command: [] };
}

function list(v) {
  return v
    ? String(v)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

function runDir(opts) {
  if (!opts.run) throw new Error("--run <dir> is required");
  const dir = resolve(ROOT, String(opts.run));
  mkdirSync(join(dir, "logs"), { recursive: true });
  return dir;
}

function readHeader(dir) {
  return JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
}

function readSteps(dir) {
  const p = join(dir, "steps.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function begin(opts) {
  const dir = runDir(opts);
  const header = {
    suite: String(opts.suite ?? "mtls"),
    run_dir: relative(ROOT, dir),
    started_at: new Date().toISOString(),
    ...testedTree(),
    versions: collectVersions(ROOT),
    host: { platform: process.platform, arch: process.arch },
  };
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(header, null, 2)}\n`);
  writeFileSync(join(dir, "steps.jsonl"), "");
  process.stdout.write(`${dir}\n`);
}

function stepBase(opts, command, header, id) {
  return {
    id,
    claim_id: String(opts.claim ?? id),
    scenario_ids: list(opts.scenarios),
    source_commit: header.source_commit,
    tested_tree: header.tested_tree,
    implementation_paths: list(opts.paths),
    transport_profile: String(opts.profile ?? "n/a"),
    execution_target: String(opts.target ?? "local"),
    required: String(opts.required ?? "true") === "true",
    runner: String(opts.runner ?? "shell"),
    command: command.join(" "),
    expected: String(opts.expected ?? ""),
    coverage_limit: String(opts.coverage_limit ?? ""),
    recorded_at: new Date().toISOString(),
  };
}

function skippedRecord(base, opts) {
  const reason = String(opts.skip ?? opts.unsupported);
  const record = {
    ...base,
    exit_code: null,
    result: opts.unsupported ? "unsupported" : "not_executed",
    reason,
    observed: reason,
    tests: null,
    artifacts: [],
    duration_ms: 0,
  };
  if (base.required && !opts.unsupported) {
    record.result = "failed";
    record.reason = `required step skipped: ${reason}`;
  }
  return record;
}

async function executedRecord(base, opts, command, logPath) {
  const timeoutMs = Number(opts.timeout ?? 900) * 1000;
  const r = await runBounded(command, {
    cwd: ROOT,
    env: process.env,
    timeoutMs,
    logPath,
    echo: !opts.quiet,
  });
  const counts = parseTestCounts(base.runner, r.log);
  const verdict = judge({
    runner: base.runner,
    required: base.required,
    exitCode: r.exitCode,
    counts,
    timedOut: r.timedOut,
  });
  const observed =
    verdict.result === "passed"
      ? String(opts.observed_pass ?? `exit 0, ${counts.passed} passed`)
      : `${String(opts.observed_fail ?? "")} ${verdict.reason ?? ""}`.trim();
  return {
    ...base,
    exit_code: r.exitCode,
    timed_out: r.timedOut,
    result: verdict.result,
    reason: verdict.reason,
    observed,
    tests: counts,
    artifacts: [
      {
        path: relative(ROOT, logPath),
        sha256: r.logSha256,
        redactions: r.redactions,
      },
    ],
    duration_ms: r.durationMs,
  };
}

async function runStep(opts, command) {
  const dir = runDir(opts);
  const header = readHeader(dir);
  const id = String(opts.id ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!id) throw new Error("--id is required");
  const base = stepBase(opts, command, header, id);
  let record;
  if (opts.skip || opts.unsupported) {
    record = skippedRecord(base, opts);
  } else {
    if (command.length === 0)
      throw new Error("run-step needs a command after --");
    process.stderr.write(`==> [${header.suite}] ${id}: ${base.command}\n`);
    record = await executedRecord(
      base,
      opts,
      command,
      join(dir, "logs", `${id}.log`),
    );
  }
  appendFileSync(join(dir, "steps.jsonl"), `${JSON.stringify(record)}\n`);
  process.stderr.write(
    `<== ${id}: ${record.result}${record.reason ? ` (${record.reason})` : ""}\n`,
  );
}

function finish(opts) {
  const dir = runDir(opts);
  const header = readHeader(dir);
  const steps = readSteps(dir);
  const counts = { passed: 0, failed: 0, not_executed: 0, unsupported: 0 };
  for (const s of steps) {
    if (!RESULTS.has(s.result))
      throw new Error(`step ${s.id} has invalid result ${s.result}`);
    counts[s.result] += 1;
  }
  const requiredNotPassed = steps.filter(
    (s) => s.required && s.result !== "passed",
  );
  const verdict =
    steps.length === 0
      ? "failed"
      : requiredNotPassed.length === 0
        ? "passed"
        : "failed";
  const manifest = {
    ...header,
    finished_at: new Date().toISOString(),
    counts,
    verdict,
    required_not_passed: requiredNotPassed.map((s) => s.id),
    steps,
  };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const md = renderMarkdown(manifest);
  writeFileSync(join(dir, "manifest.json"), json);
  writeFileSync(join(dir, "manifest.md"), md);
  const latest = resolve(ROOT, "artifacts", "mtls");
  mkdirSync(latest, { recursive: true });
  writeFileSync(join(latest, `manifest-${header.suite}.json`), json);
  writeFileSync(join(latest, `manifest-${header.suite}.md`), md);
  writeFileSync(join(latest, "manifest.json"), json);
  writeFileSync(join(latest, "manifest.md"), md);
  process.stdout.write(`${md}\n`);
  if (verdict !== "passed") {
    process.stderr.write(
      `mtls-manifest: ${header.suite} FAILED — required steps not passed: ${requiredNotPassed.map((s) => s.id).join(", ") || "(no steps recorded)"}\n`,
    );
    process.exit(1);
  }
}

function summarize(files) {
  const paths =
    files.length > 0
      ? files
      : [join(ROOT, "artifacts", "mtls", "manifest.json")];
  const out = [];
  for (const p of paths) {
    const m = JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));
    out.push(
      `### ${m.suite} — ${m.verdict} (commit \`${m.source_commit.slice(0, 12)}\`, tree \`${m.tested_tree.slice(0, 12)}\`)`,
      "",
    );
    out.push(summarizeRows(m.steps), "");
  }
  process.stdout.write(`${out.join("\n")}\n`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { opts, command } = parseArgs(rest);
  switch (cmd) {
    case "begin":
      return begin(opts);
    case "run-step":
      return runStep(opts, command);
    case "finish":
      return finish(opts);
    case "summarize":
      return summarize(opts._ ?? []);
    case "sanitize": {
      const [inp, outp] = opts._ ?? [];
      if (!inp || !outp) throw new Error("sanitize <in> <out>");
      const { text, redactions } = sanitize(readFileSync(resolve(inp), "utf8"));
      writeFileSync(resolve(outp), text);
      process.stdout.write(`${JSON.stringify(redactions)}\n`);
      return;
    }
    default:
      process.stderr.write(
        "usage: mtls-manifest.mjs begin|run-step|finish|summarize|sanitize\n",
      );
      process.exit(2);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    process.stderr.write(`mtls-manifest: ${err.message}\n`);
    process.exit(1);
  });
}
