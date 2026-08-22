import { overlapCast } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cliSeams, runCli } from "./cli.js";

describe("mock-upstream-idp cli", () => {
  beforeEach(() => {
    cliSeams.main = vi.fn();
  });

  it("invokes main() on startup", async () => {
    vi.mocked(cliSeams.main).mockResolvedValue(undefined);
    runCli();
    expect(cliSeams.main).toHaveBeenCalledTimes(1);
  });

  it("logs the error and exits 1 when main() rejects", async () => {
    const failure = new Error("boom");
    vi.mocked(cliSeams.main).mockRejectedValue(failure);
    const errorSpy = vi.fn();
    const exitSpy = vi.fn();
    cliSeams.error = errorSpy;
    cliSeams.exit = overlapCast(exitSpy);
    runCli();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    expect(errorSpy).toHaveBeenCalledWith(failure);
  });
});
