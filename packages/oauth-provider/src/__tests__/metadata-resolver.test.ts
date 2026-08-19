import { describe, expect, it } from "vitest";
import {
  SafeMetadataFetcher,
  UnsafeMetadataUrlError,
  assertSafeMetadataUrl,
  resolveSafeMetadataAddresses,
} from "../metadata/safe-fetcher.js";

const throwingLookup = async (): Promise<
  Array<{ address: string; family: number }>
> => {
  throw new Error("literal IPs must not hit DNS");
};

describe("assertSafeMetadataUrl structural checks", () => {
  it("rejects unparseable URLs", () => {
    expect(() => assertSafeMetadataUrl("not a url")).toThrow(
      UnsafeMetadataUrlError,
    );
  });

  it("rejects non-http(s) protocols", () => {
    expect(() => assertSafeMetadataUrl("ftp://example.test/x.json")).toThrow(
      /Unsupported protocol/,
    );
    expect(() => assertSafeMetadataUrl("file:///etc/passwd")).toThrow(
      /Unsupported protocol/,
    );
  });

  it("blocks subdomains of localhost and the unspecified IPv6 address", () => {
    expect(() => assertSafeMetadataUrl("https://evil.localhost/x")).toThrow(
      /Blocked hostname/,
    );
    expect(() => assertSafeMetadataUrl("http://[::]/x")).toThrow(
      UnsafeMetadataUrlError,
    );
  });
});

describe("resolveSafeMetadataAddresses", () => {
  const url = (raw: string) => new URL(raw);

  it("returns literal public IPs without touching DNS", async () => {
    await expect(
      resolveSafeMetadataAddresses(url("https://8.8.8.8/x"), throwingLookup),
    ).resolves.toEqual(["8.8.8.8"]);
    await expect(
      resolveSafeMetadataAddresses(
        url("https://[2606:4700::1111]/x"),
        throwingLookup,
      ),
    ).resolves.toEqual(["2606:4700::1111"]);
  });

  it("rejects literal private IPs without touching DNS", async () => {
    await expect(
      resolveSafeMetadataAddresses(url("https://10.1.2.3/x"), throwingLookup),
    ).rejects.toThrow(/Blocked address: 10.1.2.3/);
  });

  it("wraps DNS failures and empty answers", async () => {
    await expect(
      resolveSafeMetadataAddresses(
        url("https://a.example.test/x"),
        async () => {
          throw new Error("ENOTFOUND");
        },
      ),
    ).rejects.toThrow(/DNS lookup failed for a.example.test/);

    await expect(
      resolveSafeMetadataAddresses(
        url("https://a.example.test/x"),
        async () => [],
      ),
    ).rejects.toThrow(/No DNS records for a.example.test/);
  });

  it("dedupes resolved addresses and lets public ones through", async () => {
    const addresses = await resolveSafeMetadataAddresses(
      url("https://a.example.test/x"),
      async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "8.8.8.8", family: 4 },
        { address: "1.1.1.1", family: 4 },
      ],
    );
    expect(addresses).toEqual(["8.8.8.8", "1.1.1.1"]);
  });

  it("rejects special IPv4 ranges returned by DNS", async () => {
    const blocked = [
      "0.1.2.3", // 0.0.0.0/8 "this network"
      "192.0.2.1", // 192.0.0.0/24 protocol assignments
      "198.18.0.1", // benchmarking
      "100.64.0.1", // CGNAT
      "not-an-ip", // unparseable answers fail closed
    ];
    for (const address of blocked) {
      await expect(
        resolveSafeMetadataAddresses(
          url("https://a.example.test/x"),
          async () => [{ address, family: 4 }],
        ),
        address,
      ).rejects.toThrow(/Blocked resolved address/);
    }
  });

  it("expands and judges IPv6 answers in every textual form", async () => {
    const blocked = [
      "::ffff:127.0.0.1", // dotted-quad mapped loopback
      "::1", // loopback
      "::", // unspecified
      "64:ff9b::7f00:1", // NAT64 wrapping 127.0.0.1
      "2002:7f00:1::", // 6to4 wrapping 127.0.0.1
      "2002:a9fe:a9fe::1", // 6to4 wrapping 169.254.169.254
      "::ffff:999.0.0.1", // invalid dotted octets
      "1::2::3", // two "::" runs
      "zz::1", // non-hex hextet
      "1:2:3:4:5:6:7:8:9", // too many hextets
    ];
    for (const address of blocked) {
      await expect(
        resolveSafeMetadataAddresses(
          url("https://a.example.test/x"),
          async () => [{ address, family: 6 }],
        ),
        address,
      ).rejects.toThrow(/Blocked resolved address/);
    }
  });

  it("allows NAT64/6to4 wrappers around public IPv4 destinations", async () => {
    for (const address of ["64:ff9b::808:808", "2002:808:808::"]) {
      await expect(
        resolveSafeMetadataAddresses(
          url("https://a.example.test/x"),
          async () => [{ address, family: 6 }],
        ),
        address,
      ).resolves.toEqual([address]);
    }
  });
});

describe("SafeMetadataFetcher status handling", () => {
  it("rejects non-2xx responses from the pinned transport", async () => {
    const fetcher = new SafeMetadataFetcher(
      { cimdEnabled: true },
      {
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        transport: async () => ({
          status: 503,
          contentType: "application/json",
          body: "{}",
        }),
      },
    );
    await expect(
      fetcher.fetch("https://clients.example.test/client.json"),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("returns the URL, body and content type on success", async () => {
    const fetcher = new SafeMetadataFetcher(
      { cimdEnabled: true },
      {
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        transport: async () => ({
          status: 200,
          contentType: "application/json",
          body: '{"client_id":"x"}',
        }),
      },
    );
    const result = await fetcher.fetch(
      "https://clients.example.test/client.json",
    );
    expect(result.url).toBe("https://clients.example.test/client.json");
    expect(result.contentType).toBe("application/json");
  });
});
