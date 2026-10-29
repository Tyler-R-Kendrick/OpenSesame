import { ChildProcess, type SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  AgentBrowser,
  type AgentBrowserConfig,
  parseAgentBrowserSnapshot,
} from "./agent-browser.js";
import { detectChallenge, legalCandidates } from "./decisions.js";
import { ORIGIN } from "./test-support.js";

type SpawnAnswer = Readonly<{
  output: string;
  code?: number;
  stderr?: string;
}>;

function queueSpawn(outputs: SpawnAnswer[]) {
  const spawn = vi.fn(
    (_executable: string, _args: readonly string[], _options: SpawnOptions) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const stdio: [PassThrough, PassThrough, PassThrough] = [
        stdin,
        stdout,
        stderr,
      ];
      const child = Object.assign(new ChildProcess(), {
        stdin,
        stdout,
        stderr,
        stdio,
        kill: vi.fn(),
      });
      const next = outputs.shift() ?? { output: "" };
      process.nextTick(() => {
        child.stderr.end(next.stderr ?? "");
        child.stdout.end(next.output);
        child.emit("close", next.code ?? 0);
      });
      return child;
    },
  );
  return spawn;
}

function config(
  spawn: NonNullable<AgentBrowserConfig["spawn"]>,
): AgentBrowserConfig {
  return {
    executable: "/opt/user/agent-browser",
    session: "reset-run-1",
    allowedDomains: ["accounts.example.test"],
    secretFill: vi.fn(async () => undefined),
    spawn,
  };
}

describe("agent-browser adapter", () => {
  it("uses a fenced session and keeps secrets out of commands and snapshots", async () => {
    const url = JSON.stringify({
      success: true,
      data: { url: `${ORIGIN}/reset?token=DO_NOT_EXPOSE` },
    });
    const snapshot = JSON.stringify({
      success: true,
      data: {
        snapshot: "New password FIELD_CANARY",
        refs: {
          e1: { role: "textbox", name: "New password", value: "FIELD_CANARY" },
        },
      },
    });
    const spawn = queueSpawn([
      { output: "" },
      { output: url },
      { output: snapshot },
      { output: "" },
      { output: "" },
    ]);
    const cfg = config(spawn);
    const browser = new AgentBrowser(cfg);
    await browser.open(`${ORIGIN}/reset?token=MAIL_CAPABILITY`);
    const current = await browser.snapshot();
    await browser.click("e1");
    await browser.fill("e1", "IDENTIFIER_CANARY");
    await browser.fillSecret("e1", "REAL_PASSWORD_CANARY");

    expect(spawn).toHaveBeenNthCalledWith(
      1,
      cfg.executable,
      [
        "--session",
        cfg.session,
        "--allowed-domains",
        "accounts.example.test",
        "--max-output",
        "1000000",
        "--no-webmcp",
        "open",
        `${ORIGIN}/reset?token=MAIL_CAPABILITY`,
      ],
      expect.objectContaining({ shell: false }),
    );
    expect(current.fields).toEqual([
      { ref: "e1", kind: "password", label: "New password" },
    ]);
    expect(JSON.stringify(current)).not.toContain("CANARY");
    expect(cfg.secretFill).toHaveBeenCalledWith("@e1", "REAL_PASSWORD_CANARY");
    expect(JSON.stringify(vi.mocked(spawn).mock.calls)).not.toContain(
      "REAL_PASSWORD_CANARY",
    );
  });

  it("surfaces static challenge copy as one canonical static field", () => {
    const output = JSON.stringify({
      success: true,
      data: {
        snapshot:
          '- paragraph\n  - StaticText "CAPTCHA verify you are human UNTRUSTED_PAGE_WORDS"\n- textbox "Email" [ref=e2]',
        refs: { e2: { role: "textbox", name: "Email" } },
      },
    });
    const parsed = parseAgentBrowserSnapshot(output, ORIGIN);
    expect(parsed.fields).toEqual([
      { ref: "e2", kind: "email", label: "Email" },
      { ref: "e3", kind: "static", label: "CAPTCHA verify you are human" },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("UNTRUSTED_PAGE_WORDS");
    expect(detectChallenge(parsed)).toBe("captcha");
    // The synthetic ref is evidence for the person handoff, never an
    // actionable candidate: no fill may target e3.
    expect(
      legalCandidates(parsed).some(
        (candidate) =>
          "ref" in candidate.action && candidate.action.ref === "e3",
      ),
    ).toBe(false);
    expect(
      legalCandidates(parsed).some(
        (candidate) => candidate.action.kind === "await-human",
      ),
    ).toBe(true);
  });

  it("does not surface persistent CAPTCHA branding as a pending challenge", () => {
    const output = JSON.stringify({
      success: true,
      data: {
        snapshot:
          '- paragraph\n  - StaticText "This site is protected by reCAPTCHA"\n- textbox "Email" [ref=e2]',
        refs: { e2: { role: "textbox", name: "Email" } },
      },
    });
    const parsed = parseAgentBrowserSnapshot(output, ORIGIN);
    expect(parsed.fields).toEqual([
      { ref: "e2", kind: "email", label: "Email" },
    ]);
    expect(detectChallenge(parsed)).toBeNull();
  });

  it("surfaces an active robot check as a pending challenge", () => {
    const output = JSON.stringify({
      success: true,
      data: {
        snapshot:
          '- paragraph\n  - StaticText "I\'m not a robot"\n- textbox "Email" [ref=e2]',
        refs: { e2: { role: "textbox", name: "Email" } },
      },
    });
    const parsed = parseAgentBrowserSnapshot(output, ORIGIN);
    expect(parsed.fields).toContainEqual({
      ref: "e3",
      kind: "static",
      label: "CAPTCHA verify you are human",
    });
    expect(detectChallenge(parsed)).toBe("captcha");
  });

  it("does not reflect secret-bearing child stderr into errors", async () => {
    const browser = new AgentBrowser(
      config(
        queueSpawn([{ output: "", code: 1, stderr: "REAL_PASSWORD_CANARY" }]),
      ),
    );
    await expect(browser.open(ORIGIN)).rejects.toThrow(
      /^agent-browser command failed$/,
    );
  });
});
