import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const helper = resolve("scripts/test/emulator-boot-diagnostics.py");
const workflow = readFileSync(".github/workflows/native-admission.yml", "utf8");

async function fixture(waitExit, inspect) {
  const directory = mkdtempSync(join(tmpdir(), "emulator-bootstrap-control-"));
  const sdk = join(directory, "sdk");
  const evidence = join(directory, "evidence");
  mkdirSync(join(sdk, "platform-tools"), { recursive: true });
  mkdirSync(evidence, { mode: 0o700 });
  const adb = join(sdk, "platform-tools", "adb");
  writeFileSync(
    adb,
    '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$*" >> "$CONTROL_COMMANDS"\nprintf "%s\\n" "$$" > "$CONTROL_CHILD_PID"\nif [ "$3" = wait-for-device ]; then exit "$CONTROL_WAIT_EXIT"; fi\nprintf "Synthetic input-service diagnostic\\n"\nwhile :; do sleep 1; done\n',
  );
  chmodSync(adb, 0o700);
  const commands = join(directory, "commands.txt");
  const run = (mode) =>
    spawnSync("python3", [helper, mode, evidence], {
      env: {
        ...process.env,
        ANDROID_HOME: sdk,
        CONTROL_COMMANDS: commands,
        CONTROL_WAIT_EXIT: String(waitExit),
        CONTROL_CHILD_PID: join(directory, "child.pid"),
      },
      encoding: "utf8",
    });
  try {
    const started = run("start");
    expect(started.status).toBe(0);
    expect(started.stdout).toBe("");
    await inspect({
      commands,
      evidence,
      run,
      childPid: join(directory, "child.pid"),
    });
  } finally {
    run("stop");
    rmSync(directory, { recursive: true, force: true });
  }
}

async function awaitContents(path, needle) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(path, "utf8").includes(needle)) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await setTimeout(20);
  }
  throw new Error("Diagnostic orchestration control did not finish");
}

const result = (directory) =>
  JSON.parse(readFileSync(join(directory, "collector-result.json"), "utf8"));

describe("bounded emulator diagnostics never establish feature execution", () => {
  it("starts detached, observes only the selected device and reaps its child", async () => {
    await fixture(0, async ({ commands, evidence, run, childPid }) => {
      await awaitContents(commands, "logcat");
      const scope = JSON.parse(readFileSync(join(evidence, "scope.json")));
      expect(scope.maximumSeconds).toBe(600);
      expect(scope.serial).toBe("emulator-5554");
      const calls = readFileSync(commands, "utf8").trim().split("\n");
      expect(calls).toEqual([
        "-s emulator-5554 wait-for-device",
        "-s emulator-5554 logcat -v threadtime *:S SystemServer:W InputManager:W InputDispatcher:W AndroidRuntime:W",
      ]);
      expect(run("stop").status).toBe(0);
      const child = Number(readFileSync(childPid, "utf8"));
      expect(() => process.kill(child, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
      expect(result(evidence)).toEqual({
        status: "stopped",
        exit: 0,
        childrenReaped: true,
        featureAssertionsExecuted: false,
      });
      expect(readFileSync(join(evidence, "boot.log"), "utf8")).toContain(
        "Synthetic input-service diagnostic",
      );
    });
  });

  it("preserves a real orchestration child failure37 without logging payloads or starting tests", async () => {
    await fixture(37, async ({ commands, evidence, run }) => {
      await awaitContents(join(evidence, "collector-result.json"), "failed");
      expect(run("stop").status).toBe(37);
      expect(result(evidence)).toEqual({
        status: "failed",
        exit: 37,
        childrenReaped: true,
        featureAssertionsExecuted: false,
      });
      expect(readFileSync(commands, "utf8").trim()).toBe(
        "-s emulator-5554 wait-for-device",
      );
    });
  });

  it("initializes evidence before setup and keeps the original action, tests and page-size matrix", () => {
    const device = workflow
      .split("  android-device:\n")[1]
      .split("  apple-sdk:\n")[0];
    expect(device.indexOf("id: emulator_evidence")).toBeLessThan(
      device.indexOf("uses: actions/checkout@"),
    );
    expect(device).toContain("a421e43855164a8197daf9d8d40fe71c6996bb0d");
    expect(device).toContain("emulator-boot-timeout: 600");
    expect(device).toContain("pages: 4096");
    expect(device).toContain("pages: 16384");
    expect(device).toContain("pre-emulator-launch-script: python3");
    expect(device).toContain(
      "script: bash apps/android/scripts/test-android-device.sh",
    );
    expect(device).not.toContain("continue-on-error");
    expect(device).toContain("if-no-files-found: error");
    expect(device).toContain("b7c566a772e6b6bfb58ed0dc250532a479d7789f");
    const cleanup = device.split("Stop and reap")[1].split("Preserve only")[0];
    expect(cleanup).toContain("if: always()");
    expect(cleanup).toContain('stop "$EMULATOR_BOOT_EVIDENCE"');
  });
});
