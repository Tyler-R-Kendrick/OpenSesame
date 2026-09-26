import { describe, expect, it } from "vitest";
import {
  TAG,
  bitString,
  boolean,
  concat,
  encodeLength,
  explicit,
  implicit,
  namedBits,
  objectIdentifier,
  octetString,
  sequence,
  setOf,
  smallInteger,
  time,
  tlv,
  toPem,
  unsignedInteger,
  utf8String,
} from "./der.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const from = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));

describe("encodeLength", () => {
  it("uses the short form below 128", () => {
    expect(hex(encodeLength(0))).toBe("00");
    expect(hex(encodeLength(1))).toBe("01");
    expect(hex(encodeLength(0x7f))).toBe("7f");
  });

  it("uses 0x81 for one length byte", () => {
    expect(hex(encodeLength(0x80))).toBe("8180");
    expect(hex(encodeLength(0xff))).toBe("81ff");
  });

  it("uses 0x82 for two length bytes, with no leading zero", () => {
    expect(hex(encodeLength(0x100))).toBe("820100");
    expect(hex(encodeLength(0x1234))).toBe("821234");
    expect(hex(encodeLength(0xffff))).toBe("82ffff");
    expect(hex(encodeLength(0x10000))).toBe("83010000");
  });

  it("refuses negative and fractional lengths", () => {
    expect(() => encodeLength(-1)).toThrow(RangeError);
    expect(() => encodeLength(1.5)).toThrow(RangeError);
  });

  it("frames content of each length form", () => {
    expect(hex(tlv(TAG.OCTET_STRING, new Uint8Array(3)))).toBe("0403000000");
    const long = tlv(TAG.OCTET_STRING, new Uint8Array(200));
    expect(hex(long.subarray(0, 3))).toBe("0481c8");
    expect(long.length).toBe(203);
    const longer = tlv(TAG.OCTET_STRING, new Uint8Array(300));
    expect(hex(longer.subarray(0, 4))).toBe("0482012c");
    expect(longer.length).toBe(304);
  });
});

describe("INTEGER", () => {
  it("encodes zero as a single zero byte", () => {
    expect(hex(unsignedInteger(new Uint8Array(0)))).toBe("020100");
    expect(hex(unsignedInteger(new Uint8Array(4)))).toBe("020100");
    expect(hex(smallInteger(0))).toBe("020100");
  });

  it("drops redundant leading zero bytes", () => {
    expect(hex(unsignedInteger(from("00007f")))).toBe("02017f");
    expect(hex(unsignedInteger(from("000001ff")))).toBe("020201ff");
  });

  it("adds one leading zero when the top bit is set, so the value stays positive", () => {
    expect(hex(unsignedInteger(from("80")))).toBe("02020080");
    expect(hex(unsignedInteger(from("0000ff01")))).toBe("020300ff01");
    expect(hex(smallInteger(128))).toBe("02020080");
  });

  it("encodes small integers minimally", () => {
    expect(hex(smallInteger(2))).toBe("020102");
    expect(hex(smallInteger(127))).toBe("02017f");
    expect(hex(smallInteger(256))).toBe("02020100");
    expect(hex(smallInteger(65_537))).toBe("0203010001");
    expect(() => smallInteger(-1)).toThrow(RangeError);
  });
});

describe("OBJECT IDENTIFIER", () => {
  it("packs the first two arcs into one byte", () => {
    expect(hex(objectIdentifier("2.5.4.3"))).toBe("0603550403");
    expect(hex(objectIdentifier("2.5.29.19"))).toBe("0603551d13");
  });

  it("writes arcs of 128 and above in base 128 with continuation bits", () => {
    expect(hex(objectIdentifier("1.2.840.10045.4.3.2"))).toBe(
      "06082a8648ce3d040302",
    );
    expect(hex(objectIdentifier("1.2.840.10045.2.1"))).toBe(
      "06072a8648ce3d0201",
    );
    expect(hex(objectIdentifier("1.3.6.1.5.5.7.3.1"))).toBe(
      "06082b06010505070301",
    );
    expect(hex(objectIdentifier("2.999.3"))).toBe("0603883703");
  });

  it("refuses malformed identifiers", () => {
    for (const bad of ["", "1", "3.1", "1.40", "1.2.03", "1..2", "a.b"]) {
      expect(() => objectIdentifier(bad), bad).toThrow(RangeError);
    }
  });
});

describe("Time", () => {
  it("uses UTCTime from 1950 through 2049", () => {
    expect(hex(time(new Date("2026-09-26T08:05:03.999Z")))).toBe(
      `170d${Buffer.from("260926080503Z").toString("hex")}`,
    );
    expect(Buffer.from(time(new Date("1950-01-01T00:00:00Z"))).toString()).toBe(
      "\x17\x0d500101000000Z",
    );
    expect(Buffer.from(time(new Date("2049-12-31T23:59:59Z"))).toString()).toBe(
      "\x17\x0d491231235959Z",
    );
  });

  it("uses GeneralizedTime from 2050 on and before 1950", () => {
    expect(Buffer.from(time(new Date("2050-01-01T00:00:00Z"))).toString()).toBe(
      "\x18\x0f20500101000000Z",
    );
    expect(Buffer.from(time(new Date("1949-12-31T23:59:59Z"))).toString()).toBe(
      "\x18\x0f19491231235959Z",
    );
    expect(Buffer.from(time(new Date("9999-12-31T23:59:59Z"))).toString()).toBe(
      "\x18\x0f99991231235959Z",
    );
  });

  it("refuses an invalid date and a year GeneralizedTime cannot hold", () => {
    expect(() => time(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => time(new Date("+010000-01-01T00:00:00Z"))).toThrow(RangeError);
  });
});

describe("strings, bits and constructed types", () => {
  it("encodes UTF-8 by bytes, not characters", () => {
    expect(hex(utf8String("é"))).toBe("0c02c3a9");
  });

  it("prefixes whole-byte BIT STRINGs with zero unused bits", () => {
    expect(hex(bitString(from("abcd")))).toBe("030300abcd");
  });

  it("trims trailing zero bits from named bit lists", () => {
    expect(hex(namedBits([0]))).toBe("03020780");
    expect(hex(namedBits([0, 2]))).toBe("030205a0");
    expect(hex(namedBits([5]))).toBe("03020204");
    expect(hex(namedBits([8]))).toBe("0303070080");
    expect(hex(namedBits([]))).toBe("030100");
  });

  it("encodes booleans canonically", () => {
    expect(hex(boolean(true))).toBe("0101ff");
    expect(hex(boolean(false))).toBe("010100");
  });

  it("nests sequences, sets and context tags", () => {
    expect(hex(sequence())).toBe("3000");
    expect(hex(sequence(smallInteger(1), octetString(from("ff"))))).toBe(
      "3006020101" + "0401ff",
    );
    expect(hex(setOf(smallInteger(1)))).toBe("3103020101");
    expect(hex(explicit(0, smallInteger(2)))).toBe("a003020102");
    expect(hex(explicit(3, sequence()))).toBe("a3023000");
    expect(hex(implicit(2, Buffer.from("a.b")))).toBe("8203612e62");
    expect(hex(implicit(7, from("7f000001")))).toBe("87047f000001");
  });

  it("joins byte strings", () => {
    expect(hex(concat([from("01"), new Uint8Array(0), from("0203")]))).toBe(
      "010203",
    );
  });
});

describe("toPem", () => {
  it("wraps base64 at 64 characters between the labels", () => {
    const der = Uint8Array.from({ length: 100 }, (_, index) => index);
    const pem = toPem(der, "CERTIFICATE");
    const lines = pem.trimEnd().split("\n");
    expect(lines[0]).toBe("-----BEGIN CERTIFICATE-----");
    expect(lines.at(-1)).toBe("-----END CERTIFICATE-----");
    expect(lines[1]).toHaveLength(64);
    expect(lines.slice(1, -1).join("")).toBe(
      Buffer.from(der).toString("base64"),
    );
    expect(pem.endsWith("-----\n")).toBe(true);
  });
});
