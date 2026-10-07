import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const names = [
  "captured_long_equality_filter_keeps_exact_bind_and_neutral_sql",
  "captured_claim_and_fresh_expired_claimed_controls_replay_real_verifier",
  "captured_missing_sensitive_value_and_present_value_stay_omitted",
  "captured_grant_replays_the_actual_attenuation_helper",
  "unrestricted_audience_narrows_but_restricted_parent_cannot_be_widened",
  "metadata_clamps_characters_without_like_escaping",
];
const cases = names.map((name) => `test ${name} ... ok`);
const summary =
  "test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s";

function parsed(lines, exit = "0", newline = "\n") {
  const root = mkdtempSync(join(tmpdir(), "os-normal-rust-report-"));
  try {
    writeFileSync(join(root, "run.log"), lines.join(newline) + newline);
    writeFileSync(join(root, "cargo.exit"), `${exit}\n`);
    const result = spawnSync(
      process.env.PYTHON || "python3",
      [
        "-B",
        "scripts/quality/rust-normal-regression-report.py",
        join(root, "run.log"),
        join(root, "cargo.exit"),
        join(root, "results.json"),
      ],
      { encoding: "utf8" },
    );
    return {
      status: result.status,
      report: JSON.parse(readFileSync(join(root, "results.json"), "utf8")),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it.each(["\n", "\r\n"])(
  "admits exactly six actual captured normal libtest identities with %j",
  (newline) => {
    const result = parsed([...cases, summary], "0", newline);
    expect(result.status).toBe(0);
    expect(result.report.accepted).toBe(true);
    expect(result.report.actual).toHaveLength(6);
  },
);

it.each([
  ["missing", [...cases.slice(1), summary], "0"],
  ["duplicate", [...cases, cases[0], summary], "0"],
  [
    "ignored",
    [cases[0].replace("ok", "ignored"), ...cases.slice(1), summary],
    "0",
  ],
  [
    "failed",
    [cases[0].replace("ok", "FAILED"), ...cases.slice(1), summary],
    "0",
  ],
  ["unexpected", [...cases, "test unexpected ... ok", summary], "0"],
  [
    "empty",
    [
      "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 6 filtered out; finished in 0.00s",
    ],
    "0",
  ],
  ["compile failure", [...cases, summary], "101"],
  ["duplicate summary", [...cases, summary, summary], "0"],
  [
    "interleaved output",
    [`${cases[0]} note`, ...cases.slice(1), "ok", summary],
    "0",
  ],
])("rejects %s independently of the declared count", (_name, lines, exit) => {
  const result = parsed(lines, exit);
  expect(result.status).not.toBe(0);
  expect(result.report.accepted).toBe(false);
});

function execution(regressionExit) {
  const root = mkdtempSync(join(tmpdir(), "os-normal-rust-order-"));
  try {
    const checkout = join(root, "checkout");
    const evidence = join(root, "evidence");
    const bin = join(root, "bin");
    mkdirSync(join(checkout, "scripts/test"), { recursive: true });
    mkdirSync(evidence, { mode: 0o700 });
    mkdirSync(bin);
    copyFileSync(
      "scripts/test/test-depth-run.sh",
      join(checkout, "scripts/test/test-depth-run.sh"),
    );
    writeFileSync(
      join(checkout, "scripts/test/fuzz-rust-regressions.sh"),
      '#!/usr/bin/env bash\nprintf "stable\\n" >> "$COMMAND_TRACE"\nexit "$REGRESSION_EXIT"\n',
    );
    writeFileSync(
      join(bin, "pnpm"),
      '#!/usr/bin/env bash\n[[ "$*" == audit:fuzz ]] || exit 92\nprintf "campaign\\n" >> "$COMMAND_TRACE"\n',
      { mode: 0o700 },
    );
    expect(spawnSync("git", ["init", "--quiet", checkout]).status).toBe(0);
    const result = spawnSync(
      "bash",
      [resolve(checkout, "scripts/test/test-depth-run.sh"), "fuzz-rust"],
      {
        cwd: checkout,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_DEPTH_EVIDENCE: evidence,
          COMMAND_TRACE: join(evidence, "calls"),
          REGRESSION_EXIT: regressionExit,
        },
        encoding: "utf8",
      },
    );
    return {
      status: result.status,
      calls: readFileSync(join(evidence, "calls"), "utf8"),
      stable: readFileSync(
        join(evidence, "commands/fuzz-rust-regressions.exit"),
        "utf8",
      ),
      campaign: readFileSync(join(evidence, "commands/fuzz-rust.exit"), "utf8"),
      family: readFileSync(join(evidence, "family.exit"), "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it.each(["0", "17"])(
  "records stable replay before unchanged campaign and retains status %s (recording commands only)",
  (exit) => {
    const result = execution(exit);
    expect(result.calls).toBe("stable\ncampaign\n");
    expect(result.stable).toBe(`${exit}\n`);
    expect(result.campaign).toBe("0\n");
    expect(result.family).toBe(exit === "0" ? "0\n" : "1\n");
    expect(result.status).toBe(exit === "0" ? 0 : 1);
  },
);
