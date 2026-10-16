import { describe, expect, it, vi } from "vitest";
import type { CliAppIntegrationPort } from "./cli-app-integration-client.js";
import { runCli } from "./run.js";

const approveAppIntegration: CliAppIntegrationPort = {
  ensureReveal: async () => "approve",
};

async function withTerminal<T>(body: () => Promise<T>): Promise<T> {
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
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
    if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
    if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
  }
}

describe("os:// references in the CLI run lane", () => {
  it("runs a child with os:// env values and mounts resolved locally", async () => {
    const readLocal = vi.fn(async (reference: string) =>
      reference.endsWith("/cert") ? "pem-bytes" : "local-value",
    );
    const runWithValues = vi.fn(async () => 0);
    const code = await runCli(
      [
        "run",
        "--env",
        "API=os://personal/item-1/apiKey",
        "--mount",
        "CERT_FILE=os://personal/item-1/cert",
        "--",
        "node",
        "app.js",
      ],
      {
        parityPort: {
          invoke: vi.fn(async () => ""),
          readLocal,
          runWithValues,
        },
        appIntegration: approveAppIntegration,
      },
    );
    expect(code).toBe(0);
    expect(readLocal).toHaveBeenCalledWith("os://personal/item-1/apiKey");
    expect(readLocal).toHaveBeenCalledWith("os://personal/item-1/cert");
    expect(runWithValues).toHaveBeenCalledWith(
      ["node", "app.js"],
      { API: "local-value" },
      [{ name: "CERT_FILE", value: "pem-bytes" }],
      ["local-value", "pem-bytes"],
    );
  });

  it("reads an os:// reference for a human at a terminal", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const readLocal = vi.fn(async () => "local-value\n");
    try {
      const code = await withTerminal(() =>
        runCli(["read", "os://personal/item-1/apiKey", "--reveal"], {
          parityPort: {
            invoke: vi.fn(async () => ""),
            readLocal,
          },
          appIntegration: approveAppIntegration,
        }),
      );
      expect(code).toBe(0);
      expect(readLocal).toHaveBeenCalledWith("os://personal/item-1/apiKey");
      const out = stdout.mock.calls.map(([value]) => String(value)).join("");
      expect(out).toContain("local-value");
    } finally {
      stdout.mockRestore();
    }
  });
});
