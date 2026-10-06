import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  OPE_EXPANSION_BITS,
  domainBits,
  opeEncrypt,
  opeHex,
  opeHexBounds,
  opeHexWidth,
} from "./ope.js";

const key = (fill: number) => new Uint8Array(32).fill(fill);
const WIDE = 1n << 48n;

describe("order-preserving encryption", () => {
  it("keeps the order of any two values of a wide domain", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: WIDE - 1n }),
        fc.bigInt({ min: 0n, max: WIDE - 1n }),
        (a, b) => {
          const x = opeEncrypt(key(1), WIDE, a);
          const y = opeEncrypt(key(1), WIDE, b);
          expect(x < y).toBe(a < b);
          expect(x === y).toBe(a === b);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("keeps every neighbour in order across a small domain", () => {
    let previous = -1n;
    for (let m = 0n; m < 300n; m++) {
      const c = opeEncrypt(key(2), 300n, m);
      expect(c).toBeGreaterThan(previous);
      previous = c;
    }
  });

  it("is deterministic and bound to its key", () => {
    const a = opeEncrypt(key(1), WIDE, 123456789n);
    expect(opeEncrypt(key(1), WIDE, 123456789n)).toBe(a);
    expect(opeEncrypt(key(2), WIDE, 123456789n)).not.toBe(a);
  });

  it("stays inside its range and refuses a value outside the domain", () => {
    const bits = domainBits(1000n) + OPE_EXPANSION_BITS;
    for (const m of [0n, 1n, 500n, 998n, 999n]) {
      const c = opeEncrypt(key(3), 1000n, m);
      expect(c).toBeGreaterThanOrEqual(0n);
      expect(c).toBeLessThan(1n << BigInt(bits));
    }
    expect(() => opeEncrypt(key(3), 1000n, 1000n)).toThrow(RangeError);
    expect(() => opeEncrypt(key(3), 1000n, -1n)).toThrow(RangeError);
  });

  it("handles a domain of one value", () => {
    expect(opeEncrypt(key(4), 1n, 0n)).toBeGreaterThanOrEqual(0n);
  });

  it("spreads values over the range rather than clustering them", () => {
    const bits = BigInt(domainBits(WIDE) + OPE_EXPANSION_BITS);
    const quarter = (1n << bits) / 4n;
    const at = (m: bigint) => opeEncrypt(key(5), WIDE, m);
    // The domain's middle lands near the range's middle: within a quarter.
    const middle = at(WIDE / 2n);
    expect(middle).toBeGreaterThan(quarter);
    expect(middle).toBeLessThan(3n * quarter);
    // Evenly spaced inputs land in each quarter of the range.
    const hits = new Set<bigint>();
    for (let i = 0n; i < 16n; i++) hits.add(at((i * WIDE) / 16n) / quarter);
    expect(hits.size).toBe(4);
  });

  it("writes hex that sorts as the numbers do", () => {
    const hexes = [10n, 20n, 30n, 4000n].map((m) => opeHex(key(6), WIDE, m));
    expect(hexes.every((h) => h.length === opeHexWidth(WIDE))).toBe(true);
    expect([...hexes].sort()).toEqual(hexes);
    const [floor, ceiling] = opeHexBounds(WIDE);
    expect(hexes.every((hex) => floor < hex && hex < ceiling)).toBe(true);
  });
});
