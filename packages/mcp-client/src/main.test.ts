import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./server.js";
import { stdioTransportSeams } from "./stdio-transport.js";

const TransportMock = vi.fn(function (this: {
  start(): void;
  close(): void;
}) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  TransportMock.mockClear();
});

describe("main", () => {
  it("connects over stdio without requiring Host API env", async () => {
    stdioTransportSeams.StdioServerTransport = overlapCast(TransportMock);
    vi.stubEnv("OPENSESAME_HOST_API", "http://evil.example.com");
    vi.stubEnv("OPENSESAME_ISSUER", "not a url");
    await expect(main()).resolves.toBeUndefined();
    expect(TransportMock).toHaveBeenCalledTimes(1);
  });
});
