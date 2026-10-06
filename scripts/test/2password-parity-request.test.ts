import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type RequestOptions,
  type RequestPorts,
  describeRequest,
  isPublicAddress,
  requestWith,
} from "../../packages/app-core/src/lib/password-agent/request.js";

const secret = 'PRIVATE-"QUOTED"-REQUEST-SENTINEL';
const options: RequestOptions = {
  url: "https://api.example.test/reset/PATH_PRIVATE?token=QUERY_PRIVATE",
  reference: "op://Personal/Example/credential",
};
function fixture(value = `${secret}\r\n`) {
  const calls: string[] = [];
  const ports: RequestPorts = {
    async addresses(hostname) {
      calls.push(`dns:${hostname}`);
      return [{ address: "1.1.1.1", family: 4 }];
    },
    async resolve(ref) {
      calls.push(`resolve:${ref}`);
      return value;
    },
    async send(prepared, received, address, limits) {
      calls.push("send");
      expect(prepared.url.href).toBe(options.url);
      expect(prepared.header).toBe("Authorization");
      expect(prepared.prefix).toBe("Bearer ");
      expect(received).toBe(secret);
      expect(address).toEqual({ address: "1.1.1.1", family: 4 });
      expect(limits).toEqual({ maxBytes: 65536, timeoutMs: 15000 });
      const body = `${secret} ${JSON.stringify(secret)} private@example.test NEW_TOKEN_PRIVATE`;
      return { status: 200, body, bytes: Buffer.byteLength(body) };
    },
  };
  return { calls, ports };
}
describe("2password parity core", () => {
  it("request.shape", async () => {
    for (const changes of [
      { url: "http://api.example.test/" },
      { url: "https://user:private@api.example.test/" },
      { url: "https://api.example.test:8443/" },
      { url: "https://api.example.test/#fragment" },
      { url: `https://api.example.test/${"x".repeat(2049)}` },
      { header: "Host" },
      { header: "Cookie" },
      { prefix: "Bearer\r\nHost: attacker" },
      { prefix: "x".repeat(65) },
      { reference: "PRIVATE_PLAINTEXT" },
      { reference: "op://Personal/Example/%0asecret" },
    ]) {
      const f = fixture();
      await expect(
        requestWith({ ...options, ...changes }, f.ports),
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
  });
  it("request.public-dns", async () => {
    const privateV4 = [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
    ];
    const privateV6 = [
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::1",
      "100::1",
      "2001::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "3ffe::1",
      "3fff::1",
      "4000::1",
      "7000::1",
      "5f00::1",
      "fc00::1",
      "fe80::1",
      "ff00::1",
    ];
    for (const address of privateV4)
      expect(isPublicAddress({ address, family: 4 })).toBe(false);
    for (const address of privateV6)
      expect(isPublicAddress({ address, family: 6 })).toBe(false);
    for (const address of ["1.1.1.1", "8.8.8.8"])
      expect(isPublicAddress({ address, family: 4 })).toBe(true);
    expect(
      isPublicAddress({ address: "2606:4700:4700::1111", family: 6 }),
    ).toBe(true);
    for (const answer of [
      [],
      [
        { address: "1.1.1.1", family: 4 as const },
        { address: "127.0.0.1", family: 4 as const },
      ],
    ]) {
      const f = fixture();
      f.ports.addresses = async () => {
        f.calls.push("dns");
        return answer;
      };
      await expect(requestWith(options, f.ports)).rejects.toThrow(
        "public addresses",
      );
      expect(f.calls).toEqual(["dns"]);
    }
  });
  it("request.pinned-transport", async () => {
    const f = fixture();
    await requestWith(options, f.ports);
    expect(f.calls).toEqual([
      "dns:api.example.test",
      `resolve:${options.reference}`,
      "send",
    ]);
  });
  it("request.receipt-only", async () => {
    const f = fixture();
    const receipt = await requestWith(options, f.ports);
    expect(receipt).toEqual({
      ok: true,
      status: 200,
      destination: "https://api.example.test",
      destinationFingerprint: createHash("sha256")
        .update(options.url)
        .digest("hex"),
      reference: options.reference,
      responseBytes: expect.any(Number),
      secretEchoes: 2,
    });
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|private@example|body/);
    expect(
      describeRequest({
        ...options,
        url: options.url.replace("QUERY_PRIVATE", "other"),
      }).destinationFingerprint,
    ).not.toBe(receipt.destinationFingerprint);
  });
  it("request.bounds", async () => {
    for (const response of [
      { status: 200, body: "x".repeat(65537), bytes: 65537 },
      { status: 200, body: "é".repeat(32769), bytes: 1 },
    ]) {
      const f = fixture();
      f.ports.send = async (_prepared, _secret, _address, limits) => {
        f.calls.push("send");
        expect(limits).toEqual({ maxBytes: 65536, timeoutMs: 15000 });
        return response;
      };
      await expect(requestWith(options, f.ports)).rejects.toThrow(
        "HTTPS request failed (details suppressed)",
      );
      expect(f.calls.filter((x) => x === "send")).toHaveLength(1);
    }
    const f = fixture();
    f.ports.send = async () => {
      f.calls.push("send");
      throw new Error(secret);
    };
    await expect(requestWith(options, f.ports)).rejects.toThrow(
      "HTTPS request failed (details suppressed)",
    );
    expect(f.calls.filter((x) => x === "send")).toHaveLength(1);
  });
  it("request.header-input", async () => {
    for (const value of ["", "\n", "a\nb", "a\r\nb", "a\0b", "a\n\n"]) {
      const f = fixture(value);
      await expect(requestWith(options, f.ports)).rejects.toThrow(
        "HTTP header",
      );
      expect(f.calls).toEqual([
        "dns:api.example.test",
        `resolve:${options.reference}`,
      ]);
    }
    await expect(
      requestWith(options, fixture(`${secret}\n`).ports),
    ).resolves.toMatchObject({ ok: true });
  });
});
