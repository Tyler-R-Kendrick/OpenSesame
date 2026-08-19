import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The db:migrate / db:reset CLI guards run at module load when argv[1] names
 * the script. With DATABASE_URL empty, main() reports the missing URL and
 * exits 1; with process.exit stubbed as a no-op, execution then falls into the
 * (unreachable-server) migration call, whose rejection lands in the module's
 * .catch handler — a second exit(1). Waiting for both calls before restoring
 * the stub guarantees the real process.exit is never invoked.
 */
async function runCliGuard(script: "migrate" | "reset", message: string) {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "");
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const originalArgv1 = process.argv[1];
  process.argv[1] = `/repo/packages/database/src/${script}.ts`;
  try {
    if (script === "migrate") {
      await import("../src/migrate.js");
    } else {
      await import("../src/reset.js");
    }
    expect(errorSpy).toHaveBeenCalledWith(message);
    await vi.waitFor(
      () => {
        // Once: the missing-URL guard. Twice: the rejected migration call
        // landing in the module-level .catch handler.
        expect(exitSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 15_000 },
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  } finally {
    if (originalArgv1 !== undefined) {
      process.argv[1] = originalArgv1;
    }
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("CLI entry guards", () => {
  it("db:migrate exits 1 with a clear message when DATABASE_URL is unset", async () => {
    await runCliGuard("migrate", "DATABASE_URL is required for db:migrate");
  }, 30_000);

  it("db:reset exits 1 with a clear message when DATABASE_URL is unset", async () => {
    await runCliGuard("reset", "DATABASE_URL is required for db:reset");
  }, 30_000);
});
