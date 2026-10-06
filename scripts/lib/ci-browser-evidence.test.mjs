import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFromHere } from "./ci-changed-areas.mjs";

const ci = readFileSync(
  join(repoRootFromHere(), ".github/workflows/ci.yml"),
  "utf8",
);
const bundle = ci.split("  bundle:\n")[1].split("\n  device-inbox:")[0];
const steps = bundle.split("    steps:\n")[1].split(/\n {6}- /);
const step = (name) => steps.find((text) => text.includes(`name: ${name}\n`));
const shell = (text) =>
  text.split("        run: |\n")[1].replace(/^ {10}/gm, "");
const expression = "${{ steps.browser_evidence.outputs.root }}";
const targets = [
  "browser",
  "controlled",
  "extensions/main",
  "extensions/autofill",
  "duress",
];

function initialized(dir) {
  const output = join(dir, "output.txt");
  const result = spawnSync("bash", ["-e", "-c", shell(steps[0])], {
    env: {
      ...process.env,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: "1234",
      GITHUB_SHA: "source-under-test",
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(output, "utf8").trim().split("root=").at(-1);
}

describe("CI extension prerequisite independence", () => {
  it("installs the pinned browser and runs both extension walks despite an earlier auth gate failure", () => {
    const names = [
      "Install Chromium for extension security integration",
      "Extension retired credentials and worker isolation",
      "Autofill retired credentials and worker isolation",
    ];
    for (const name of names) {
      expect(step(name)).toContain("if: always() && matrix.shard == 'auth'");
      expect(step(name)).not.toMatch(/continue-on-error|\|\| true/);
    }
    expect(step(names[0])).toContain(
      "@opensesame/browser-extension exec playwright install --with-deps chromium",
    );
    expect(ci.indexOf(`name: ${names[0]}`)).toBeLessThan(
      ci.indexOf(`name: ${names[1]}`),
    );
    expect(ci.indexOf(`name: ${names[1]}`)).toBeLessThan(
      ci.indexOf(`name: ${names[2]}`),
    );
  });
});

describe("CI browser evidence belongs to the current attempt", () => {
  it("initializes unique directories before checkout so early setup failures cannot upload old passing reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-ci-evidence-"));
    try {
      expect(steps[0]).toContain("id: browser_evidence");
      expect(steps[1]).toContain("uses: actions/checkout@");
      const old = join(dir, "checkout/docs/evidence/browser");
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, "results.json"), '{"gate":"passed"}');
      const first = initialized(dir);
      // Re-running a job must not reuse its previous artifact directory.
      rmSync(join(dir, "output.txt"));
      const second = initialized(dir);
      expect(first).not.toBe(second);
      for (const root of [first, second]) {
        for (const target of targets) {
          expect(readdirSync(join(root, target))).toEqual(["run.txt"]);
          expect(readFileSync(join(root, target, "run.txt"), "utf8")).toContain(
            "Source: source-under-test",
          );
        }
      }
      expect(readFileSync(join(old, "results.json"), "utf8")).toContain(
        '"passed"',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures every feature/setup command's raw diagnostics without converting its failure into success", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-ci-capture-"));
    try {
      for (const target of targets)
        mkdirSync(join(dir, target), { recursive: true });
      const recorded = steps.filter((text) => text.includes(" | tee "));
      expect(recorded).toHaveLength(8);
      for (const text of recorded) {
        const env = { ...process.env };
        for (const match of text.matchAll(/^ {10}([A-Z_]+): (.+)$/gm)) {
          env[match[1]] = match[2].replaceAll(expression, dir);
        }
        for (const status of [0, 37]) {
          const run = shell(text)
            .replaceAll(expression, dir)
            .replace(
              /pnpm[^\n]* 2>&1/,
              `bash -c 'printf "raw failure diagnostic\\n"; exit ${status}' 2>&1`,
            );
          const result = spawnSync("bash", ["-e", "-c", run], {
            env,
            encoding: "utf8",
          });
          expect(result.status, text).toBe(status);
          const log = /tee "([^"]+)"/
            .exec(run)[1]
            .replace(/\$([A-Z_]+)/g, (_, key) => env[key]);
          expect(readFileSync(log, "utf8")).toBe("raw failure diagnostic\n");
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes both extension gates and all uploads to isolated outputs, retaining failure uploads and no optional gates", () => {
    const names = [
      "Duress owner enrollment and isolated synthetic unlock",
      "Retired credentials and synthetic owner recovery",
      "Retired credentials after offline service worker restart",
      "Browser canary export and independent sealed receiver",
      "Extension retired credentials and worker isolation",
      "Autofill retired credentials and worker isolation",
      "Preserve duress browser evidence",
      "Preserve browser admission evidence",
    ];
    for (const name of names) {
      const text = step(name);
      expect(text, name).toContain(expression);
      expect(text).not.toContain("docs/evidence/");
      expect(text).not.toContain("continue-on-error");
    }
    for (const name of [
      "Preserve duress browser evidence",
      "Preserve browser admission evidence",
    ]) {
      expect(step(name)).toContain("if: always() && matrix.shard == '");
      expect(step(name)).toContain("if-no-files-found: error");
    }
  });
});
