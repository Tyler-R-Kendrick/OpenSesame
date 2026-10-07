import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function run(family, failingCommand = "") {
  const root = mkdtempSync(join(tmpdir(), "os-depth-execution-contract-"));
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  const evidence = join(root, "evidence");
  mkdirSync(checkout);
  mkdirSync(bin);
  mkdirSync(evidence, { mode: 0o700 });
  spawnSync("git", ["init", "--quiet", checkout]);
  const command = join(bin, "pnpm");
  writeFileSync(
    command,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$COMMAND_TRACE"\nif [[ "$*" == "$FAILING_COMMAND" ]]; then exit 17; fi\n',
  );
  chmodSync(command, 0o700);
  const result = spawnSync(
    "bash",
    [resolve("scripts/test/test-depth-run.sh"), family],
    {
      cwd: checkout,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_DEPTH_EVIDENCE: evidence,
        COMMAND_TRACE: join(evidence, "calls"),
        FAILING_COMMAND: failingCommand,
      },
      encoding: "utf8",
    },
  );
  return { result, evidence };
}

function toolBootstrap(
  family,
  version = "ripgrep 14.1.1",
  failInstall = false,
) {
  const root = mkdtempSync(join(tmpdir(), "os-depth-ripgrep-contract-"));
  const bin = join(root, "bin");
  const evidence = join(root, "evidence");
  mkdirSync(bin);
  mkdirSync(evidence, { mode: 0o700 });
  const trace = join(evidence, "install-calls");
  const commands = {
    cargo: `#!/usr/bin/env bash
if [[ "$2" == install ]]; then
  printf '%s\\n' "$*" >> "$INSTALL_TRACE"
  [[ "$INSTALL_FAILURE" == no ]] || exit 17
  [[ "$5" == 14.1.1 && "$8" == ripgrep ]] || exit 92
  mkdir -p "$7/bin"
  cp "$RG_FIXTURE" "$7/bin/rg"
else
  exit 93
fi
`,
    pnpm: `#!/usr/bin/env bash
if [[ "$1" == --version ]]; then printf '%s\\n' 9.15.0; exit 0; fi
[[ -x "$RUNNER_TEMP/test-depth-tools/bin/rg" ]] || exit 96
rg --version | sed -n '1p' | grep -Fx 'ripgrep 14.1.1'
`,
    node: "#!/usr/bin/env bash\nprintf '%s\\n' v22.23.3\n",
    rustc: "#!/usr/bin/env bash\nprintf '%s\\n' 'rustc 1.88.0 (fixture)'\n",
    python3: "#!/usr/bin/env bash\nexit 95\n",
  };
  for (const [name, source] of Object.entries(commands)) {
    writeFileSync(join(bin, name), source, { mode: 0o700 });
  }
  const fixture = join(root, "recording-rg");
  writeFileSync(
    fixture,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$RG_VERSION"\n',
    {
      mode: 0o700,
    },
  );
  const githubPath = join(evidence, "github-path");
  const result = spawnSync(
    "bash",
    [resolve("scripts/test/test-depth-tools.sh"), family],
    {
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        RUNNER_TEMP: root,
        TEST_DEPTH_EVIDENCE: evidence,
        GITHUB_PATH: githubPath,
        INSTALL_TRACE: trace,
        INSTALL_FAILURE: failInstall ? "yes" : "no",
        RG_FIXTURE: fixture,
        RG_VERSION: version,
      },
      encoding: "utf8",
    },
  );
  return { root, result, trace, githubPath };
}

describe("test-depth command orchestration (recording fixtures, not tool campaigns)", () => {
  it("keeps an early scanner failure and still executes all independent scans", () => {
    const { result, evidence } = run("scans", "audit:cve-lite");
    expect(result.status).toBe(1);
    expect(
      readFileSync(join(evidence, "calls"), "utf8").trim().split("\n"),
    ).toEqual([
      "audit:cve-lite",
      "audit:osv",
      "audit:ast-grep",
      "audit:gitleaks",
      "audit:semgrep",
      "audit:cargo-audit",
    ]);
    expect(readFileSync(join(evidence, "commands/cve-lite.exit"), "utf8")).toBe(
      "17\n",
    );
    expect(
      readFileSync(join(evidence, "commands/cargo-audit.exit"), "utf8"),
    ).toBe("0\n");
    expect(readFileSync(join(evidence, "family.exit"), "utf8")).toBe("1\n");
  });

  it("requires the actual full verify invocation to succeed", () => {
    expect(run("verify", "verify").result.status).toBe(1);
    const { result, evidence } = run("verify");
    expect(result.status).toBe(0);
    expect(readFileSync(join(evidence, "calls"), "utf8")).toBe("verify\n");
  });

  it("refuses an unknown or omitted family", () => {
    expect(run("not-a-family").result.status).toBe(2);
    expect(run("").result.status).not.toBe(0);
  });
});

describe("ripgrep bootstrap orchestration (recording installers, not real installs)", () => {
  it.each(["verify", "scans"])(
    "installs the pinned tool before %s consumers",
    (family) => {
      const { root, result, trace, githubPath } = toolBootstrap(family);
      // Scanner installation stops at its separate recording sentinel after rg admission.
      expect(result.status).toBe(family === "verify" ? 0 : 95);
      expect(readFileSync(trace, "utf8")).toBe(
        `+1.88.0 install --locked --version 14.1.1 --root ${root}/test-depth-tools ripgrep\n`,
      );
      expect(existsSync(join(root, "test-depth-tools/bin/rg"))).toBe(true);
      expect(readFileSync(githubPath, "utf8")).toContain(
        `${root}/test-depth-tools/bin\n`,
      );
    },
  );

  it.each(["verify", "scans"])(
    "fails %s before consumers when the real installer fails",
    (family) => {
      const { root, result } = toolBootstrap(family, "ripgrep 14.1.1", true);
      expect(result.status).toBe(17);
      expect(existsSync(join(root, "test-depth-tools/bin/rg"))).toBe(false);
    },
  );

  it("rejects a wrong first line even when a later line names the pinned version", () => {
    expect(
      toolBootstrap("verify", "ripgrep 0.0.0\nripgrep 14.1.1").result.status,
    ).toBe(1);
  });

  it("preserves a family without ripgrep consumers", () => {
    const { result, trace } = toolBootstrap("feature-mutation");
    expect(result.status).toBe(0);
    expect(existsSync(trace)).toBe(false);
  });
});
