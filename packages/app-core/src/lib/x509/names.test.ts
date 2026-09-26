import { describe, expect, it } from "vitest";
import { isDnsName, parseIpAddress, parseIpv4, parseIpv6 } from "./names.js";

const hex = (bytes: Uint8Array | null) =>
  bytes === null ? null : Buffer.from(bytes).toString("hex");

describe("isDnsName", () => {
  it.each([
    "localhost",
    "barber.local",
    "www.barber.local",
    "a-b.example.com",
    "xn--bcher-kva.example",
    "*.dev.local",
    "1password.com",
    `${"a".repeat(63)}.local`,
  ])("accepts %s", (name) => {
    expect(isDnsName(name)).toBe(true);
  });

  it.each([
    "",
    "*",
    "a.*.local",
    "*.*.local",
    "-lead.local",
    "trail-.local",
    "under_score.local",
    "a..b",
    ".lead",
    "trail.",
    "sp ace.local",
    "bücher.local",
    "10.0.0.1",
    "host.123",
    `${"a".repeat(64)}.local`,
    `${"a.".repeat(127)}ab`,
  ])("rejects %j", (name) => {
    expect(isDnsName(name)).toBe(false);
  });
});

describe("parseIpv4", () => {
  it("parses dotted quads to four octets", () => {
    expect(hex(parseIpv4("127.0.0.1"))).toBe("7f000001");
    expect(hex(parseIpv4("255.255.255.255"))).toBe("ffffffff");
    expect(hex(parseIpv4("0.0.0.0"))).toBe("00000000");
  });

  it.each([
    "256.0.0.1",
    "1.2.3",
    "1.2.3.4.5",
    "01.2.3.4",
    "1.2.3.-4",
    "a.b.c.d",
    " 1.2.3.4",
    "1.2.3.4 ",
  ])("rejects %j", (text) => {
    expect(parseIpv4(text)).toBeNull();
  });
});

describe("parseIpv6", () => {
  it("parses the full and compressed forms to sixteen octets", () => {
    expect(hex(parseIpv6("::1"))).toBe(`${"00".repeat(15)}01`);
    expect(hex(parseIpv6("::"))).toBe("00".repeat(16));
    expect(hex(parseIpv6("fe80::"))).toBe(`fe80${"00".repeat(14)}`);
    expect(hex(parseIpv6("2001:db8::8a2e:370:7334"))).toBe(
      "20010db8000000000000" + "8a2e03707334",
    );
    expect(hex(parseIpv6("2001:DB8:0:0:1:0:0:1"))).toBe(
      "20010db8000000000001000000000001",
    );
    expect(hex(parseIpv6("1:2:3:4:5:6:7::"))).toBe(
      "0001000200030004000500060007" + "0000",
    );
  });

  it("parses an embedded IPv4 tail", () => {
    expect(hex(parseIpv6("::ffff:192.168.1.10"))).toBe(
      `${"00".repeat(10)}ffffc0a8010a`,
    );
    expect(hex(parseIpv6("0:0:0:0:0:ffff:1.2.3.4"))).toBe(
      `${"00".repeat(10)}ffff01020304`,
    );
  });

  it.each([
    "",
    ":",
    ":::",
    "1::2::3",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8::",
    ":1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:",
    "12345::",
    "g::1",
    "fe80::1%eth0",
    "[::1]",
    "::1.2.3.4:5",
    "1.2.3.4::",
    "::256.0.0.1",
    "1:2:3:4:5:6:7:1.2.3.4",
  ])("rejects %j", (text) => {
    expect(parseIpv6(text)).toBeNull();
  });
});

describe("parseIpAddress", () => {
  it("dispatches on the presence of a colon", () => {
    expect(parseIpAddress("10.1.2.3")?.length).toBe(4);
    expect(parseIpAddress("::1")?.length).toBe(16);
    expect(parseIpAddress("localhost")).toBeNull();
  });
});
