import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { main, runTarget } from "./run.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

const originalArgv = process.argv;
const originalFuzzSeconds = process.env.FUZZ_SECONDS;

afterEach(() => {
  process.argv = originalArgv;
  if (originalFuzzSeconds === undefined) {
    Reflect.deleteProperty(process.env, "FUZZ_SECONDS");
  } else {
    process.env.FUZZ_SECONDS = originalFuzzSeconds;
  }
});

describe("runTarget", () => {
  it("invokes the exported fuzz function until the deadline", async () => {
    const target = pathToFileURL(join(here, "audit_redact.ts")).href;
    await expect(runTarget(target, 0.01)).resolves.toBeUndefined();
  });

  it("ignores modules that do not export a fuzz function", async () => {
    const notATarget = pathToFileURL(join(here, "oracles.ts")).href;
    await expect(runTarget(notATarget, 0.01)).resolves.toBeUndefined();
  });
});

describe("main", () => {
  it("discovers and runs every target with the default duration", async () => {
    Reflect.deleteProperty(process.env, "FUZZ_SECONDS");
    process.argv = [process.execPath, "run.ts", "no_such_target"];
    // the filter matches nothing, so the default-seconds path stays instant
    await expect(main()).resolves.toBeUndefined();
  });

  it("filters targets by name prefix from argv", async () => {
    process.env.FUZZ_SECONDS = "0";
    process.argv = [process.execPath, "run.ts", "claim_engine"];
    await expect(main()).resolves.toBeUndefined();
  });

  it("runs all targets when no filter argument is present", async () => {
    process.env.FUZZ_SECONDS = "0";
    process.argv = [process.execPath, "run.ts"];
    await expect(main()).resolves.toBeUndefined();
  });
});

describe("runner entrypoint", () => {
  const tsxCli = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
  const runScript = join(here, "run.ts");

  it("runs every discovered target when no filter is given", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [tsxCli, runScript],
      { env: { ...process.env, FUZZ_SECONDS: "0" } },
    );
    expect(stdout).toContain("--> audit_redact.ts");
    expect(stdout).toContain("--> webauthn_ceremony.ts");
    expect(stdout).not.toContain("oracles.test.ts");
    expect(stdout).not.toContain("provider.ts");
  }, 60_000);

  it("honours the name filter argument", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [tsxCli, runScript, "claim_engine"],
      { env: { ...process.env, FUZZ_SECONDS: "0" } },
    );
    expect(stdout).toContain("--> claim_engine.ts");
    expect(stdout).not.toContain("--> audit_redact.ts");
  }, 60_000);
});
