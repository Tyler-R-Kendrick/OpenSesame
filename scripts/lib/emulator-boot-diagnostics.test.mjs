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
import { delimiter, join, resolve } from "node:path";
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
    [
      "#!/usr/bin/env bash",
      "set -eu",
      'printf "%s\\n" "$*" >> "$CONTROL_COMMANDS"',
      'if [ "$1" != -s ]; then',
      '  case "$*" in',
      '    "shell getconf PAGE_SIZE") printf "4096\\n" ;;',
      '    "shell am instrument "*) exit 7 ;;',
      '    "exec-out "*) exit 1 ;;',
      "  esac",
      "  exit 0",
      "fi",
      'printf "%s\\n" "$$" > "$CONTROL_CHILD_PID"',
      'if [ "$3" = wait-for-device ]; then exit "$CONTROL_WAIT_EXIT"; fi',
      'printf "Synthetic input-service diagnostic\\n"',
      'while :; do if [ -n "${CONTROL_OFFLINE:-}" ] && [ -f "$CONTROL_OFFLINE" ]; then exit 255; fi; sleep 1; done',
      "",
    ].join("\n"),
  );
  chmodSync(adb, 0o700);
  const commands = join(directory, "commands.txt");
  const environment = {
    ...process.env,
    ANDROID_HOME: sdk,
    PATH: join(sdk, "platform-tools") + delimiter + process.env.PATH,
    CONTROL_COMMANDS: commands,
    CONTROL_WAIT_EXIT: String(waitExit),
    CONTROL_CHILD_PID: join(directory, "child.pid"),
    CONTROL_OFFLINE: join(directory, "offline"),
    EMULATOR_BOOT_EVIDENCE: evidence,
  };
  const run = (mode) =>
    spawnSync("python3", [helper, mode, evidence], {
      env: environment,
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
      environment,
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

const finishHelper = resolve(
  "apps/android/scripts/finish-emulator-collector.sh",
);

function finishApplication(environment, status) {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$CONTROL_FINISH_HELPER"; app_status=0; bash -c \'exit "$CONTROL_APPLICATION_STATUS"\' || app_status=$?; finish_emulator_collector "$app_status"',
    ],
    {
      env: {
        ...environment,
        CONTROL_FINISH_HELPER: finishHelper,
        CONTROL_APPLICATION_STATUS: String(status),
      },
      encoding: "utf8",
      timeout: 25_000,
    },
  );
}

// Genuine process orchestration only: these commands never prove Android app behavior.
describe("native runner finishes its verified collector before emulator teardown", () => {
  it("reaps the live child before the device goes offline and keeps outer stop idempotent", async () => {
    await fixture(
      0,
      async ({ commands, evidence, run, childPid, environment }) => {
        await awaitContents(commands, "logcat");
        expect(finishApplication(environment, 0).status).toBe(0);
        expect(result(evidence)).toEqual({
          status: "stopped",
          exit: 0,
          childrenReaped: true,
          featureAssertionsExecuted: false,
        });
        const child = Number(readFileSync(childPid, "utf8"));
        expect(() => process.kill(child, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
        writeFileSync(environment.CONTROL_OFFLINE, "device offline\n");
        expect(run("stop").status).toBe(0);
        expect(result(evidence).status).toBe("stopped");
      },
    );
  });

  it("runs the real device EXIT trap, preserves instrumentation failure7 and reaps before offline", async () => {
    await fixture(
      0,
      async ({ commands, evidence, run, childPid, environment }) => {
        await awaitContents(commands, "logcat");
        const apk = join(evidence, "public-command-fixture.apk");
        writeFileSync(
          apk,
          "Public orchestration fixture, not an Android application",
        );
        const deviceEnvironment = {
          ...environment,
          OPENSESAME_NATIVE_REPORT_DIR: join(evidence, "device"),
        };
        deviceEnvironment.GITHUB_SHA = undefined;
        const attempt = spawnSync(
          "bash",
          [
            resolve("apps/android/scripts/test-android-device.sh"),
            apk,
            apk,
            "4096",
          ],
          {
            env: deviceEnvironment,
            encoding: "utf8",
            timeout: 15_000,
          },
        );
        expect(attempt.status).toBe(7);
        expect(result(evidence).status).toBe("stopped");
        expect(result(evidence).childrenReaped).toBe(true);
        const child = Number(readFileSync(childPid, "utf8"));
        expect(() => process.kill(child, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
        writeFileSync(environment.CONTROL_OFFLINE, "device offline\n");
        expect(run("stop").status).toBe(0);
        expect(() =>
          readFileSync(join(evidence, "device/verified.json")),
        ).toThrow(expect.objectContaining({ code: "ENOENT" }));
      },
    );
  });

  it("keeps genuine child37 blocking app success while preserving an already failed app", async () => {
    for (const applicationStatus of [0, 7]) {
      await fixture(37, async ({ evidence, run, environment }) => {
        await awaitContents(join(evidence, "collector-result.json"), "failed");
        expect(finishApplication(environment, applicationStatus).status).toBe(
          applicationStatus || 37,
        );
        expect(run("stop").status).toBe(37);
        expect(result(evidence)).toEqual({
          status: "failed",
          exit: 37,
          childrenReaped: true,
          featureAssertionsExecuted: false,
        });
      });
    }
  });

  it("leaves the real command exit unchanged when no collector environment is configured", () => {
    for (const status of [0, 7]) {
      const environment = { ...process.env };
      environment.EMULATOR_BOOT_EVIDENCE = undefined;
      const finished = finishApplication(environment, status);
      expect(finished.status).toBe(status);
      expect(finished.stdout).toBe("");
      expect(finished.stderr).toBe("");
    }
  });
});
