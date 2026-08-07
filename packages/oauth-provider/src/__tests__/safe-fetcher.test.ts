import { describe, expect, it } from "vitest";
import {
  assertSafeMetadataUrl,
  SafeMetadataFetcher,
  UnsafeMetadataUrlError,
} from "../metadata/safe-fetcher.js";

describe("SafeMetadataFetcher SSRF denylist", () => {
  it("blocks localhost, private IPs, and metadata endpoints", () => {
    const blocked = [
      "http://localhost/meta.json",
      "http://127.0.0.1/meta.json",
      "http://10.0.0.5/meta.json",
      "http://192.168.1.1/meta.json",
      "http://172.16.0.1/meta.json",
      "http://169.254.169.254/latest/meta-data",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://[::1]/meta.json",
    ];
    for (const url of blocked) {
      expect(() => assertSafeMetadataUrl(url), url).toThrow(UnsafeMetadataUrlError);
    }
  });

  it("allows public https URLs structurally", () => {
    const url = assertSafeMetadataUrl("https://clients.example.com/client.json");
    expect(url.hostname).toBe("clients.example.com");
  });

  it("refuses fetch when CIMD is disabled", async () => {
    const fetcher = new SafeMetadataFetcher({ cimdEnabled: false });
    await expect(fetcher.fetch("https://clients.example.com/client.json")).rejects.toThrow(
      /CIMD/,
    );
  });
});
