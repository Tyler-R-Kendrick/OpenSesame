import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "./parse.js";
import { runCli } from "./run.js";
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
