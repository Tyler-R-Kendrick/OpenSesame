import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normaliseTotp } from "./import/types.js";
import { joinStorePath, splitStorePath } from "./store-sync.js";
import { decodeBase32 } from "./totp.js";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encoder written for the test so the round-trip is not self-confirming. */
function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

describe("decodeBase32 properties", () => {
  it("round-trips arbitrary secrets", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), (bytes) => {
        expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
      }),
    );
  });

  it("ignores the formatting authenticator apps and users add", () => {
    // Secrets get pasted with the spacing and casing of whatever displayed
    // them; every such rendering must decode to the same key.
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 32 }),
        fc.array(fc.constantFrom(" ", "-", "\t", "\n"), { maxLength: 12 }),
        (bytes, separators) => {
          const canonical = encodeBase32(bytes);
          let scrambled = "";
          for (let index = 0; index < canonical.length; index += 1) {
            scrambled += canonical[index];
            const sep = separators[index % Math.max(separators.length, 1)];
            if (sep) scrambled += sep;
          }
          expect(decodeBase32(scrambled.toLowerCase())).toEqual(
            decodeBase32(canonical),
          );
        },
      ),
    );
  });

  it("rejects non-alphabet input instead of decoding it silently", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((text) => {
          const clean = text.replace(/[\s-]/gu, "").replace(/=+$/u, "");
          return clean.length > 0 && !/^[A-Za-z2-7]+$/u.test(clean);
        }),
        (text) => {
          expect(() => decodeBase32(text)).toThrow();
        },
      ),
    );
  });
});

describe("normaliseTotp properties", () => {
  it("is idempotent", () => {
    // It is the single canonical normalizer for every import adapter, so a
    // value that has already been through it must survive a second pass.
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = normaliseTotp(raw);
        expect(normaliseTotp(once)).toBe(once);
      }),
    );
  });

  it("returns only an empty string, an otpauth URI, or a usable base32 seed", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.uint8Array({ minLength: 10, maxLength: 40 }).map(encodeBase32),
          fc
            .uint8Array({ minLength: 10, maxLength: 20 })
            .map((b) => `otpauth://totp/Acme:me?secret=${encodeBase32(b)}`),
        ),
        (raw) => {
          const result = normaliseTotp(raw);
          if (result === "") return;
          if (/^otpauth:\/\//iu.test(result)) return;
          expect(result).toMatch(/^[A-Z2-7]+=*$/u);
          expect(result.length).toBeGreaterThanOrEqual(16);
        },
      ),
    );
  });

  it("preserves any otpauth URI it is given", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 10, maxLength: 20 }), (bytes) => {
        const uri = `otpauth://totp/Acme:me?secret=${encodeBase32(bytes)}`;
        expect(normaliseTotp(uri)).toBe(uri);
        expect(normaliseTotp(`  ${uri}  `)).toBe(uri);
      }),
    );
  });
});

describe("store path properties", () => {
  const segment = fc
    .string({ minLength: 1, maxLength: 20 })
    .map((s) => s.replace(/[/\s]/gu, "_"))
    .filter((s) => s.trim().length > 0);

  it("round-trips a folder and name through join then split", () => {
    fc.assert(
      fc.property(segment, segment, (folder, name) => {
        const split = splitStorePath(joinStorePath(folder, name));
        expect(split).toEqual({ folder, name });
      }),
    );
  });

  it("round-trips a bare name with no folder", () => {
    fc.assert(
      fc.property(segment, (name) => {
        expect(splitStorePath(joinStorePath(null, name))).toEqual({
          folder: null,
          name,
        });
      }),
    );
  });

  it("never yields an empty name", () => {
    // An empty name would address the folder itself; callers rely on the
    // "untitled" fallback rather than handling a blank.
    fc.assert(
      fc.property(fc.string(), (path) => {
        expect(splitStorePath(path).name.length).toBeGreaterThan(0);
      }),
    );
  });
});
