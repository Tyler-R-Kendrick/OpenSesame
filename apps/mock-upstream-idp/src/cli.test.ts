import { beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./index.js";

vi.mock("./index.js", () => ({ main: vi.fn() }));

describe("mock-upstream-idp cli", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(main).mockReset();
  });

  it("invokes main() on startup", async () => {
    vi.mocked(main).mockResolvedValue(undefined);
    await import("./cli.js");
    expect(main).toHaveBeenCalledTimes(1);
  });

  it("logs the error and exits 1 when main() rejects", async () => {
    const failure = new Error("boom");
    vi.mocked(main).mockRejectedValue(failure);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      await import("./cli.js");
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
      expect(errorSpy).toHaveBeenCalledWith(failure);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
