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
  it("connects over stdio with the default loopback endpoints", async () => {
    stdioTransportSeams.StdioServerTransport = overlapCast(TransportMock);
    vi.stubEnv("OPENSESAME_HOST_API", undefined);
    vi.stubEnv("OPENSESAME_ISSUER", undefined);
    await expect(main()).resolves.toBeUndefined();
    expect(TransportMock).toHaveBeenCalledTimes(1);
  });

  it("accepts explicitly configured endpoints", async () => {
    stdioTransportSeams.StdioServerTransport = overlapCast(TransportMock);
    vi.stubEnv("OPENSESAME_HOST_API", "http://127.0.0.1:9999");
    vi.stubEnv("OPENSESAME_ISSUER", "https://id.example.com");
    await expect(main()).resolves.toBeUndefined();
    expect(TransportMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to start when the Host API URL would leak the bearer", async () => {
    stdioTransportSeams.StdioServerTransport = overlapCast(TransportMock);
    vi.stubEnv("OPENSESAME_HOST_API", "http://evil.example.com");
    await expect(main()).rejects.toThrow(
      /OPENSESAME_HOST_API must be an https URL, or http on loopback/,
    );
    expect(TransportMock).not.toHaveBeenCalled();
  });

  it("refuses to start when the Identity issuer URL is invalid", async () => {
    stdioTransportSeams.StdioServerTransport = overlapCast(TransportMock);
    vi.stubEnv("OPENSESAME_ISSUER", "not a url");
    await expect(main()).rejects.toThrow(/OPENSESAME_ISSUER must be an https/);
    expect(TransportMock).not.toHaveBeenCalled();
  });
});
