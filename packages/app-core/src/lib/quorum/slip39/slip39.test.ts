/**
 * SLIP-0039 against the standard's own vectors, then the properties the vectors
 * do not reach: round trips across layouts, and refusals for tampered or
 * mismatched shares.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Slip39Error,
  combineMnemonics,
  decodeShare,
  describeMnemonic,
  encodeShare,
  generateMnemonics,
} from "./index.js";
import { SLIP39_WORDLIST } from "./wordlist.js";

type Vector = readonly [string, readonly string[], string, string];

const here = new URL(
  "../../../../../../spec/conformance/slip39/",
  import.meta.url,
);
const vectors: readonly Vector[] = JSON.parse(
  readFileSync(new URL("vectors.json", here), "utf8"),
);

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

describe("the vendored wordlist", () => {
  it("is the standard's 1024 words, in order, and the embedded copy matches", () => {
    const file = readFileSync(new URL("wordlist.txt", here), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(file).toHaveLength(1024);
    expect(SLIP39_WORDLIST).toEqual(file);
    expect([...file].sort()).toEqual(file);
    expect(new Set(file.map((w) => w.slice(0, 4))).size).toBe(1024);
  });
});

describe("SLIP-0039 official test vectors", () => {
  it("has every vector the standard publishes", () => {
    expect(vectors).toHaveLength(45);
  });

  for (const [description, mnemonics, secret] of vectors) {
    it(description, async () => {
      if (secret === "") {
        await expect(
          combineMnemonics(mnemonics, { passphrase: "TREZOR" }),
        ).rejects.toBeInstanceOf(Slip39Error);
        return;
      }
      const recovered = await combineMnemonics(mnemonics, {
        passphrase: "TREZOR",
      });
      expect(hex(recovered)).toBe(secret);
    });
  }
});

describe("generate then combine", () => {
  const secret128 = fromHex("bb54aac4b89dc868ba37d9cc21b2cece");
  const secret256 = crypto.getRandomValues(new Uint8Array(32));

  it("round-trips a plain 3-of-5 and gives 20 words per 128-bit share", async () => {
    const [group] = await generateMnemonics({
      groupThreshold: 1,
      groups: [[3, 5]],
      masterSecret: secret128,
    });
    expect(group).toHaveLength(5);
    for (const share of group ?? []) {
      expect(share.split(" ")).toHaveLength(20);
    }
    const back = await combineMnemonics([
      group?.[4] ?? "",
      group?.[0] ?? "",
      group?.[2] ?? "",
    ]);
    expect(hex(back)).toBe(hex(secret128));
  });

  it("gives 33 words per 256-bit share and honours a passphrase", async () => {
    const [group] = await generateMnemonics({
      groupThreshold: 1,
      groups: [[2, 3]],
      masterSecret: secret256,
      passphrase: "correct horse",
    });
    expect(group?.[0]?.split(" ")).toHaveLength(33);
    const pick = [group?.[1] ?? "", group?.[2] ?? ""];
    expect(
      hex(await combineMnemonics(pick, { passphrase: "correct horse" })),
    ).toBe(hex(secret256));
    expect(hex(await combineMnemonics(pick))).not.toBe(hex(secret256));
  });

  it("round-trips the original (non-extendable) salt format", async () => {
    const [group] = await generateMnemonics({
      groupThreshold: 1,
      groups: [[2, 2]],
      masterSecret: secret128,
      extendable: false,
    });
    expect(describeMnemonic(group?.[0] ?? "").extendable).toBe(false);
    expect(hex(await combineMnemonics(group ?? []))).toBe(hex(secret128));
  });

  it("round-trips two levels: 2 of 3 groups, each with its own member threshold", async () => {
    const groups = await generateMnemonics({
      groupThreshold: 2,
      groups: [
        [1, 1],
        [3, 5],
        [2, 3],
      ],
      masterSecret: secret256,
    });
    const chosen = [
      ...(groups[1]?.slice(0, 3) ?? []),
      ...(groups[2]?.slice(1, 3) ?? []),
    ];
    expect(hex(await combineMnemonics(chosen))).toBe(hex(secret256));
  });

  it("refuses one share too few, one group too few, and too many", async () => {
    const groups = await generateMnemonics({
      groupThreshold: 2,
      groups: [
        [2, 3],
        [2, 3],
      ],
      masterSecret: secret128,
    });
    const g0 = groups[0] ?? [];
    const g1 = groups[1] ?? [];
    await expect(combineMnemonics([g0[0] ?? "", g0[1] ?? ""])).rejects.toThrow(
      /groups/,
    );
    await expect(
      combineMnemonics([g0[0] ?? "", g0[1] ?? "", g1[0] ?? ""]),
    ).rejects.toThrow(/exactly 2/);
    await expect(
      combineMnemonics([g0[0] ?? "", g0[1] ?? "", g0[2] ?? "", g1[0] ?? ""]),
    ).rejects.toThrow(/exactly 2/);
  });

  it("refuses shares from two different backups", async () => {
    const a = await generateMnemonics({
      groupThreshold: 1,
      groups: [[2, 3]],
      masterSecret: secret128,
    });
    const b = await generateMnemonics({
      groupThreshold: 1,
      groups: [[2, 3]],
      masterSecret: secret128,
    });
    await expect(
      combineMnemonics([a[0]?.[0] ?? "", b[0]?.[1] ?? ""]),
    ).rejects.toBeInstanceOf(Slip39Error);
  });

  it("refuses a 1-of-N group, which gives no extra security", async () => {
    await expect(
      generateMnemonics({
        groupThreshold: 1,
        groups: [[1, 3]],
        masterSecret: secret128,
      }),
    ).rejects.toThrow(/1-of-1/);
  });

  it("refuses a short or odd-length secret and a non-ASCII passphrase", async () => {
    const base = { groupThreshold: 1, groups: [[2, 3]] as const };
    await expect(
      generateMnemonics({ ...base, masterSecret: new Uint8Array(15) }),
    ).rejects.toBeInstanceOf(Slip39Error);
    await expect(
      generateMnemonics({ ...base, masterSecret: new Uint8Array(17) }),
    ).rejects.toBeInstanceOf(Slip39Error);
    await expect(
      generateMnemonics({
        ...base,
        masterSecret: secret128,
        passphrase: "pässword",
      }),
    ).rejects.toThrow(/printable ASCII/);
  });

  it("refuses a share that asks for more PBKDF2 work than the caller allows", async () => {
    const [group] = await generateMnemonics({
      groupThreshold: 1,
      groups: [[2, 2]],
      masterSecret: secret128,
      iterationExponent: 4,
    });
    await expect(
      combineMnemonics(group ?? [], { maxIterationExponent: 2 }),
    ).rejects.toThrow(/exceeds the limit/);
  });

  it("detects any single-word change through the checksum", async () => {
    const [group] = await generateMnemonics({
      groupThreshold: 1,
      groups: [[2, 3]],
      masterSecret: secret128,
    });
    const words = (group?.[0] ?? "").split(" ");
    for (const at of [0, 5, 10, words.length - 1]) {
      const changed = [...words];
      changed[at] = changed[at] === "academic" ? "acid" : "academic";
      expect(() => decodeShare(changed.join(" "))).toThrow(/checksum/);
    }
  });

  it("encodes and decodes the header fields it was given", () => {
    const fields = {
      identifier: 0x1234,
      extendable: true,
      iterationExponent: 3,
      groupIndex: 2,
      groupThreshold: 3,
      groupCount: 4,
      memberIndex: 5,
      memberThreshold: 6,
      value: crypto.getRandomValues(new Uint8Array(16)),
    };
    expect(decodeShare(encodeShare(fields))).toEqual(fields);
  });
});
