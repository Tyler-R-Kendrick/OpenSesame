import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SandboxTextDecoder,
  SandboxTextEncoder,
  sandboxAtob,
  sandboxBtoa,
} from "./text.js";

describe("sandbox UTF-8 codecs match the platform's", () => {
  it("encodes every string as TextEncoder does, lone surrogates included", () => {
    const ours = new SandboxTextEncoder();
    const theirs = new TextEncoder();
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        expect(ours.encode(text)).toEqual(theirs.encode(text));
      }),
    );
    expect(ours.encode("\uD800x")).toEqual(theirs.encode("\uD800x"));
  });

  it("decodes arbitrary bytes as TextDecoder does", () => {
    const ours = new SandboxTextDecoder();
    const theirs = new TextDecoder();
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        expect(ours.decode(bytes)).toBe(theirs.decode(bytes));
      }),
    );
  });

  it("throws on malformed input only when fatal", () => {
    const bad = Uint8Array.of(0xc3, 0x28);
    expect(() =>
      new SandboxTextDecoder("utf-8", { fatal: true }).decode(bad),
    ).toThrow(TypeError);
    const encodedReplacement = new TextEncoder().encode("�");
    expect(
      new SandboxTextDecoder("utf-8", { fatal: true }).decode(
        encodedReplacement,
      ),
    ).toBe("�");
    expect(() => new SandboxTextDecoder("latin1")).toThrow(RangeError);
  });

  it("round-trips base64 as atob and btoa do", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const binary = String.fromCharCode(...bytes);
        expect(sandboxBtoa(binary)).toBe(btoa(binary));
        expect(sandboxAtob(btoa(binary))).toBe(binary);
      }),
    );
    expect(() => sandboxBtoa("Ā")).toThrow(/Latin1/);
    expect(() => sandboxAtob("a")).toThrow(/not correctly encoded/);
    expect(sandboxAtob(" YW Jj ")).toBe("abc");
  });
});
