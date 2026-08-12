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

  it("blocks IPv4 literals smuggled through IPv6 and alternate radix forms", () => {
    const blocked = [
      // IPv4-mapped loopback: URL normalizes to ::ffff:7f00:1
      "http://[::ffff:127.0.0.1]/meta.json",
      "http://[::ffff:7f00:1]/meta.json",
      "http://[0:0:0:0:0:ffff:7f00:1]/meta.json",
      // IPv4-mapped cloud metadata
      "http://[::ffff:169.254.169.254]/latest/meta-data",
      // IPv4-compatible (deprecated ::x form)
      "http://[::a9fe:a9fe]/latest/meta-data",
      // Decimal / octal IPv4 that URL canonicalizes to 127.0.0.1
      "http://2130706433/meta.json",
      "http://0177.0.0.1/meta.json",
      // Unique-local, link-local, multicast
      "http://[fd00::1]/meta.json",
      "http://[fe80::1]/meta.json",
      "http://[ff02::1]/meta.json",
      "http://224.0.0.1/meta.json",
      // NAT64 and 6to4 wrappers: the network unwraps these to 127.0.0.1 and
      // 169.254.169.254 respectively.
      "http://[64:ff9b::7f00:1]/meta.json",
      "http://[64:ff9b::127.0.0.1]/meta.json",
      "http://[2002:a9fe:a9fe::1]/latest/meta-data",
    ];
    for (const url of blocked) {
      expect(() => assertSafeMetadataUrl(url), url).toThrow(UnsafeMetadataUrlError);
    }
  });

  it("allows public https URLs structurally", () => {
    const url = assertSafeMetadataUrl("https://clients.example.com/client.json");
    expect(url.hostname).toBe("clients.example.com");
    expect(assertSafeMetadataUrl("https://8.8.8.8/client.json").hostname).toBe("8.8.8.8");
    expect(assertSafeMetadataUrl("https://[2606:4700::1111]/c.json").hostname).toBe(
      "[2606:4700::1111]",
    );
  });

  it("refuses fetch when CIMD is disabled", async () => {
    const fetcher = new SafeMetadataFetcher({ cimdEnabled: false });
    await expect(fetcher.fetch("https://clients.example.com/client.json")).rejects.toThrow(
      /CIMD/,
    );
  });
});
