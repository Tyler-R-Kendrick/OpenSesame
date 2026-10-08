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
import { assertFeatureMutationExecution } from "./mutation-execution.mjs";

function report(mutant) {
  return {
    files: Object.fromEntries(
      ["broker", "client"].map((name) => [
        `packages/app-core/src/browser/security/${name}.ts`,
        { mutants: [mutant] },
      ]),
    ),
  };
}

it.each(["Killed", "Survived"])(
  "refuses a %s outcome with zero or missing executed tests despite covered test identifiers",
  (status) => {
    for (const testsCompleted of [undefined, 0, -1, "1"]) {
      expect(() =>
        assertFeatureMutationExecution(
          report({ status, testsCompleted, coveredBy: ["existing-test"] }),
        ),
      ).toThrow("executed no tests");
    }
    expect(() =>
      assertFeatureMutationExecution(report({ status, testsCompleted: 1 })),
    ).not.toThrow();
  },
);

it("preserves timeout, compile-error, and no-coverage classification without assertion-kill credit", () => {
  for (const status of ["Timeout", "CompileError", "NoCoverage"])
    expect(() =>
      assertFeatureMutationExecution(report({ status })),
    ).not.toThrow();
});

it("refuses an empty or incomplete feature report", () => {
  expect(() => assertFeatureMutationExecution({ files: {} })).toThrow();
  const partial = report({ status: "Killed", testsCompleted: 1 });
  partial.files = Object.fromEntries(
    Object.entries(partial.files).filter(([path]) =>
      path.endsWith("broker.ts"),
    ),
  );
  expect(() => assertFeatureMutationExecution(partial)).toThrow();
  expect(() =>
    assertFeatureMutationExecution({
      files: Object.fromEntries(
        Object.keys(report({}).files).map((path) => [path, { mutants: [] }]),
      ),
    }),
  ).toThrow();
});

function runRecordingCampaign(family, mutant, campaignStatus) {
  const directory = mkdtempSync(join(tmpdir(), "os-mutation-execution-"));
  const evidence = join(directory, "evidence");
  try {
    for (const path of ["bin", "scripts/lib", "artifacts/mutation", "evidence"])
      mkdirSync(join(directory, path), { recursive: true });
    const initialized = spawnSync("git", ["init", "--quiet", directory]);
    expect(initialized.status).toBe(0);
    copyFileSync(
      resolve("scripts/lib/mutation-execution.mjs"),
      join(directory, "scripts/lib/mutation-execution.mjs"),
    );
    const suffix = family === "feature-extension" ? "-genuine" : "";
    const output = `artifacts/mutation/extension-security-feature${suffix}.json`;
    writeFileSync(
      join(directory, "bin/pnpm"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$CAMPAIGN_CALL"\nif [[ "$WRITE_REPORT" == yes ]]; then cp "$REPORT_FIXTURE" "$REPORT_OUTPUT"; fi\nexit "$CAMPAIGN_STATUS"\n',
      { mode: 0o700 },
    );
    writeFileSync(
      join(directory, "report.json"),
      JSON.stringify(report(mutant)),
    );
    const result = spawnSync(
      "bash",
      [resolve("scripts/test/test-depth-run.sh"), family],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(directory, "bin")}:${process.env.PATH}`,
          TEST_DEPTH_EVIDENCE: evidence,
          CAMPAIGN_CALL: join(directory, "call"),
          REPORT_FIXTURE: join(directory, "report.json"),
          REPORT_OUTPUT: output,
          WRITE_REPORT: mutant ? "yes" : "no",
          CAMPAIGN_STATUS: String(campaignStatus),
        },
      },
    );
    return {
      status: result.status,
      call: readFileSync(join(directory, "call"), "utf8"),
      campaignExit: readFileSync(
        join(evidence, `commands/${family}.exit`),
        "utf8",
      ),
      validationExit: readFileSync(
        join(evidence, `commands/${family}-execution.exit`),
        "utf8",
      ),
      familyExit: readFileSync(join(evidence, "family.exit"), "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.each(["feature-mutation", "feature-extension"])(
  "requires actual report validation after the recording %s campaign and preserves campaign failure",
  (family) => {
    const positive = { status: "Killed", testsCompleted: 2 };
    const success = runRecordingCampaign(family, positive, 0);
    expect(success.status).toBe(0);
    expect(success.validationExit).toBe("0\n");
    const suffix = family === "feature-extension" ? "-genuine" : "";
    expect(success.call).toBe(
      `exec stryker run tools/mutation/extension-security-feature${suffix}.config.json\n`,
    );
    for (const mutant of [
      { status: "Killed", testsCompleted: 0 },
      { status: "Survived", testsCompleted: 0 },
      undefined,
    ]) {
      const refused = runRecordingCampaign(family, mutant, 0);
      expect(refused.status).toBe(1);
      expect(refused.campaignExit).toBe("0\n");
      expect(refused.validationExit).toBe("1\n");
      expect(refused.familyExit).toBe("1\n");
    }
    const originalFailure = runRecordingCampaign(family, positive, 17);
    expect(originalFailure.status).toBe(1);
    expect(originalFailure.campaignExit).toBe("17\n");
    expect(originalFailure.validationExit).toBe("0\n");
    expect(originalFailure.familyExit).toBe("1\n");
  },
);
