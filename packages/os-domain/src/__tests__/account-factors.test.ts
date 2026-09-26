import { describe, expect, it } from "vitest";
import {
  MAX_ACCOUNT_FACTORS,
  isAccountFactorId,
  parseAccountFactorList,
} from "../account-factors.js";

const PK = `pk_${"a".repeat(32)}`;

describe("account factor list", () => {
  it("copies only the display-safe fields", () => {
    const parsed = parseAccountFactorList({
      ok: true,
      factors: [
        {
          id: PK,
          kind: "passkey",
          createdAt: "2026-09-25T10:00:00.000Z",
          publicKey: "AAAA",
          counter: 7,
        },
        { id: "totp", kind: "totp", secret: "seed" },
      ],
      enrollable: ["totp", "passkey", "sms"],
    });
    expect(parsed).toEqual({
      factors: [
        { id: PK, kind: "passkey", createdAt: "2026-09-25T10:00:00.000Z" },
        { id: "totp", kind: "totp" },
      ],
      enrollable: ["passkey", "totp"],
    });
  });

  it("refuses the whole list on one bad entry", () => {
    expect(
      parseAccountFactorList({
        factors: [
          { id: PK, kind: "passkey" },
          { id: "x", kind: "passkey" },
        ],
      }),
    ).toBeNull();
    expect(
      parseAccountFactorList({ factors: [{ id: "totp", kind: "passkey" }] }),
    ).toBeNull();
    expect(
      parseAccountFactorList({ factors: [{ id: PK, kind: "totp" }] }),
    ).toBeNull();
    expect(parseAccountFactorList({ factors: "no" })).toBeNull();
    expect(parseAccountFactorList(null)).toBeNull();
  });

  it("refuses an oversized list", () => {
    const factors = Array.from({ length: MAX_ACCOUNT_FACTORS + 1 }, () => ({
      id: PK,
      kind: "passkey",
    }));
    expect(parseAccountFactorList({ factors })).toBeNull();
  });

  it("drops a created time that is not an instant", () => {
    expect(
      parseAccountFactorList({
        factors: [{ id: PK, kind: "passkey", createdAt: "yesterday" }],
      })?.factors,
    ).toEqual([{ id: PK, kind: "passkey" }]);
  });

  it("names only the two id shapes", () => {
    expect(isAccountFactorId("totp")).toBe(true);
    expect(isAccountFactorId(PK)).toBe(true);
    expect(isAccountFactorId(`pk_${"A".repeat(32)}`)).toBe(false);
    expect(isAccountFactorId("cred_raw")).toBe(false);
    expect(isAccountFactorId(3)).toBe(false);
  });
});
