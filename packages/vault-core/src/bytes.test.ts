/**
 * The base64 encoder every sealed write goes through: RFC 4648's vectors, and
 * byte for byte what `btoa` gives at every length a padding rule can tell
 * apart, and on an input as large as a sealed ledger.
 */
import { describe, expect, it } from "vitest";
import { b64ToBytes, bytesToB64 } from "./bytes.js";

const text = (value: string) => new TextEncoder().encode(value);

function reference(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("bytesToB64", () => {
  it("matches RFC 4648 §10", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "Zg=="],
      ["fo", "Zm8="],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg=="],
      ["fooba", "Zm9vYmE="],
      ["foobar", "Zm9vYmFy"],
    ];
    for (const [input, output] of vectors)
      expect(bytesToB64(text(input))).toBe(output);
  });

  it("agrees with btoa at every length to 300, every byte value included", () => {
    for (let length = 0; length <= 300; length += 1) {
      const bytes = Uint8Array.from(
        { length },
        (_, i) => (i * 37 + length) & 255,
      );
      expect(bytesToB64(bytes)).toBe(reference(bytes));
    }
  });

  it("agrees with btoa on a large random input and round-trips", () => {
    const bytes = new Uint8Array(200_003);
    for (let i = 0; i < bytes.length; i += 65_536)
      crypto.getRandomValues(bytes.subarray(i, i + 65_536));
    const encoded = bytesToB64(bytes);
    expect(encoded).toBe(reference(bytes));
    expect(b64ToBytes(encoded)).toEqual(bytes);
  });
});

describe("b64ToBytes", () => {
  it("is atob's inverse at every length to 300", () => {
    for (let length = 0; length <= 300; length += 1) {
      const bytes = Uint8Array.from(
        { length },
        (_, i) => (i * 53 + length) & 255,
      );
      expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes);
    }
  });

  it("takes what atob takes, and refuses what it refuses", () => {
    const viaAtob = (input: string) => {
      try {
        return Uint8Array.from(atob(input), (ch) => ch.charCodeAt(0));
      } catch {
        return "refused";
      }
    };
    const ours = (input: string) => {
      try {
        return b64ToBytes(input);
      } catch {
        return "refused";
      }
    };
    const inputs = ["", "Zg", "Zg=", "Zg==", "Z m9v", "Zm9v\n", "Zm9vYmFy"];
    inputs.push("Zm9v!", "Zm9v====", "é", "Z=g=", "=Zm9", "Zm=9", "Zh==");
    for (const input of inputs) expect(ours(input)).toEqual(viaAtob(input));
  });
});
