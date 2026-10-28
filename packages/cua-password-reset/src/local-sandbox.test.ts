import { ChildProcess, type SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLocalSandbox } from "./local-sandbox.js";

function spawnCapture(outputs: string[]) {
  const stdinChunks: string[] = [];
  const calls: { args: string[]; stdin: string }[] = [];
  const spawn = vi.fn(
    (_exe: string, args: readonly string[], _o: SpawnOptions) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const chunks: string[] = [];
      stdin.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
      stdinChunks.push("");
      const child = Object.assign(new ChildProcess(), {
        stdin,
        stdout,
        stderr,
        stdio: [stdin, stdout, stderr],
        kill: vi.fn(),
      });
      const next = outputs.shift() ?? "";
      process.nextTick(() => {
        calls.push({ args: [...args], stdin: chunks.join("") });
        stderr.end("");
        stdout.end(next);
        child.emit("close", 0);
      });
      return child;
    },
  );
  return { spawn, calls, stdinChunks };
}

describe("local ephemeral sandbox (zero-provision)", () => {
  it("creates an ephemeral domain-bound session with no account/config", () => {
    const { spawn } = spawnCapture([]);
    const sandbox = createLocalSandbox({
      origin: "http://127.0.0.1:4317",
      executable: "/opt/agent-browser",
      spawn: spawn as never,
    });
    expect(sandbox.session).toMatch(/^cua-/u);
    expect(sandbox.allowedDomains).toEqual(["127.0.0.1"]);
    expect(sandbox.browser.sessionName).toBe(sandbox.session);
  });

  it("refuses credential-bearing and non-http origins", () => {
    const { spawn } = spawnCapture([]);
    expect(() =>
      createLocalSandbox({
        origin: "https://user:pass@example.test",
        spawn: spawn as never,
      }),
    ).toThrow(/credential-free/u);
    expect(() =>
      createLocalSandbox({
        origin: "file:///etc/passwd",
        spawn: spawn as never,
      }),
    ).toThrow(/credential-free/u);
  });

  it("default secret fill sends the secret on stdin, never argv", async () => {
    const { spawn, calls } = spawnCapture([
      JSON.stringify([{ success: true, data: {} }]),
    ]);
    const sandbox = createLocalSandbox({
      origin: "http://127.0.0.1:4317",
      executable: "/opt/agent-browser",
      spawn: spawn as never,
    });
    await sandbox.browser.fillSecret("e3", "REAL_PASSWORD_CANARY");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.args)).not.toContain(
      "REAL_PASSWORD_CANARY",
    );
    expect(calls[0]?.stdin).toContain("REAL_PASSWORD_CANARY");
    expect(JSON.parse(calls[0]?.stdin ?? "null")).toEqual([
      ["fill", "@e3", "REAL_PASSWORD_CANARY"],
    ]);
  });

  it("refuses navigation off the allowlist before spawning", async () => {
    const { spawn, calls } = spawnCapture([]);
    const sandbox = createLocalSandbox({
      origin: "http://127.0.0.1:4317",
      executable: "/opt/agent-browser",
      spawn: spawn as never,
    });
    await expect(sandbox.browser.open("https://evil.example/")).rejects.toThrow(
      /approved domains/u,
    );
    expect(calls).toHaveLength(0);
  });
});
