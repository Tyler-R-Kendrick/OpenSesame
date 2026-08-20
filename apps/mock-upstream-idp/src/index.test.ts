import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./index.js";
import { overlapCast } from "@opensesame/os-domain";

type Signal = "SIGINT" | "SIGTERM";

function addedListeners(signal: Signal, before: NodeJS.ExitListener[]) {
  return process
    .listeners(signal)
    .filter((l) => !before.includes(overlapCast(l)));
}

describe("mock-upstream-idp main()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "starts the server, logs the endpoints, and shuts down on %s",
    async (signal) => {
      vi.stubEnv("OPENSESAME_MOCK_IDP_PORT", "0");
      vi.stubEnv("OPENSESAME_MOCK_IDP_HOST", "127.0.0.1");

      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((msg) =>
        logs.push(String(msg)),
      );
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(overlapCast(() => undefined));

      const before = {
        SIGINT: overlapCast(process.listeners("SIGINT")),
        SIGTERM: overlapCast(process.listeners("SIGTERM")),
      };
      await main();
      const added = (["SIGINT", "SIGTERM"] as const).flatMap((s) =>
        addedListeners(s, before[s]).map((l) => ({ signal: s, listener: l })),
      );

      try {
        expect(logs.some((l) => l.includes("listening at"))).toBe(true);
        expect(logs.some((l) => l.includes("discovery:"))).toBe(true);
        expect(logs.some((l) => l.includes("seed client:"))).toBe(true);
        expect(logs.some((l) => l.includes("test user:"))).toBe(true);

        process.emit(signal);
        await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
      } finally {
        for (const { signal: s, listener } of added) process.off(s, listener);
      }
    },
  );
});
