import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "./parse.js";
import { runCli } from "./run.js";

async function withTerminal<T>(body: () => Promise<T>): Promise<T> {
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const seam = process.env.OPENSESAME_CLI_APP_INTEGRATION_SEAM;
  process.env.OPENSESAME_CLI_APP_INTEGRATION_SEAM = "approve";
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
  });
  try {
    return await body();
  } finally {
    if (seam === undefined) {
      Reflect.deleteProperty(
        process.env,
        "OPENSESAME_CLI_APP_INTEGRATION_SEAM",
      );
    } else {
      process.env.OPENSESAME_CLI_APP_INTEGRATION_SEAM = seam;
    }
    if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
    if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
  }
}
describe("password-agent CLI", () => {
  it("preserves child flags after the separator", () => {
    expect(
      parseArgs([
        "run",
        "--env",
        "TOKEN=op://v/i/f",
        "--",
        "node",
        "--json",
        "--api",
        "literal",
      ]),
    ).toMatchObject({
      name: "parity",
      verb: "run",
      args: [
        "--env",
        "TOKEN=op://v/i/f",
        "--",
        "node",
        "--json",
        "--api",
        "literal",
      ],
      flags: { json: false },
    });
  });
  it("returns metadata without field values", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const invoke = vi.fn(async (args: readonly string[]) =>
      args.includes("list")
        ? JSON.stringify([
            {
              id: "a".repeat(26),
              title: "OpenAI",
              category: "API_CREDENTIAL",
              vault: { id: "b".repeat(26), name: "Automation" },
            },
          ])
        : JSON.stringify({
            id: "a".repeat(26),
            title: "OpenAI",
            category: "API_CREDENTIAL",
            vault: { id: "b".repeat(26), name: "Automation" },
            fields: [
              {
                id: "credential",
                type: "CONCEALED",
                reference: "op://v/i/credential",
                value: "secret-canary",
              },
            ],
          }),
    );
    try {
      expect(
        await runCli(["find", "openai", "--desktop"], {
          parityPort: { invoke },
        }),
      ).toBe(0);
      const output = stdout.mock.calls.map(([value]) => String(value)).join("");
      expect(output).toContain("op://v/i/credential");
      expect(output).not.toContain("secret-canary");
      expect(invoke).toHaveBeenCalledTimes(2);
    } finally {
      stdout.mockRestore();
    }
  });
  it("refuses read without human reveal gate", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const invoke = vi.fn(async () => "secret-canary");
    try {
      expect(
        await withTerminal(() =>
          runCli(["read", "op://v/i/f", "--desktop", "--reveal"], {
            parityPort: { invoke },
          }),
        ),
      ).toBe(0);
      expect(invoke).toHaveBeenCalled();
      const err = stderr.mock.calls.map(([value]) => String(value)).join("");
      expect(err).toContain('"lane":"reveal"');
    } finally {
      stderr.mockRestore();
    }
  });
  it("suppresses a malformed secret batch for a person at a terminal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensesame-reveal-"));
    const template = join(directory, "input.env");
    const output = join(directory, "output.env");
    await writeFile(template, "TOKEN=op://v/i/f\n");
    await writeFile(output, "preserved");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const invoke = vi.fn(async () => "malformed-secret-canary");
    try {
      expect(
        await withTerminal(() =>
          runCli(
            [
              "env",
              "resolve",
              template,
              "--output",
              output,
              "--desktop",
              "--reveal",
            ],
            { parityPort: { invoke } },
          ),
        ),
      ).toBe(1);
      const err = stderr.mock.calls.map(([value]) => String(value)).join("");
      expect(err).toContain("details suppressed");
      expect(err).not.toContain("malformed-secret-canary");
      expect(await readFile(output, "utf8")).toBe("preserved");
      expect(invoke).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("validates source selection before reading or writing", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const privateInput = vi.fn(async () => "never");
    const invoke = vi.fn(async () => "never");
    try {
      expect(
        await runCli(
          [
            "create",
            "api-credential",
            "--title",
            "Example",
            "--vault",
            "Automation",
            "--stdin",
            "--clipboard",
          ],
          { parityPort: { invoke }, privateInput },
        ),
      ).toBe(1);
      expect(privateInput).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});
