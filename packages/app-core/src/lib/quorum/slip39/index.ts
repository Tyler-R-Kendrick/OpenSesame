/**
 * SLIP-0039: Shamir's Secret Sharing for mnemonic codes — the interoperable
 * format a recovery export uses, so any conforming tool can combine the
 * shares without OpenSesame (ADR 0187). Verified against the standard's own
 * vectors (`spec/conformance/slip39/vectors.json`).
 *
 * Two levels, as the standard has them: a group threshold over groups, and a
 * member threshold inside each group. A plain k-of-n is one group.
 */

import { type CipherParams, decrypt, encrypt } from "./cipher.js";
import { Slip39Error } from "./errors.js";
import {
  type RandomBytes,
  recoverSecret,
  splitSecret,
  systemRandom,
} from "./shamir.js";
import { type ShareFields, decodeShare, encodeShare } from "./share.js";

export { Slip39Error } from "./errors.js";
export { MAX_ITERATION_EXPONENT } from "./cipher.js";
export { type ShareFields, decodeShare, encodeShare } from "./share.js";
export { SLIP39_WORDLIST } from "./wordlist.js";

/** A group: `[member threshold, member count]`. */
export type GroupSpec = readonly [threshold: number, count: number];

export type GenerateParams = Readonly<{
  groupThreshold: number;
  groups: readonly GroupSpec[];
  masterSecret: Uint8Array;
  /** Printable ASCII. Empty by default, which is what other tools assume. */
  passphrase?: string;
  /** PBKDF2 runs 10 000 x 2^e times in all. The reference default is 1. */
  iterationExponent?: number;
  /** New backups are extendable; `false` writes the original salt format. */
  extendable?: boolean;
  random?: RandomBytes;
}>;

function checkGenerate(p: GenerateParams): void {
  if (p.masterSecret.length * 8 < 128 || p.masterSecret.length % 2 !== 0) {
    throw new Slip39Error(
      "the master secret must be at least 128 bits and a multiple of 16 bits",
    );
  }
  if (p.groupThreshold < 1 || p.groupThreshold > p.groups.length) {
    throw new Slip39Error(
      "the group threshold must not exceed the group count",
    );
  }
  if (p.groups.length > 16) throw new Slip39Error("at most 16 groups");
  for (const [threshold, count] of p.groups) {
    if (threshold === 1 && count > 1) {
      throw new Slip39Error(
        "a member threshold of 1 needs a group of 1: use 1-of-1 sharing",
      );
    }
  }
}

/** GenerateShares: one list of mnemonics per group, in group order. */
export async function generateMnemonics(
  params: GenerateParams,
): Promise<string[][]> {
  checkGenerate(params);
  const random = params.random ?? systemRandom;
  const idBytes = random(2);
  const identifier = (((idBytes[0] ?? 0) << 8) | (idBytes[1] ?? 0)) & 0x7fff;
  const cipher: CipherParams = {
    passphrase: params.passphrase ?? "",
    iterationExponent: params.iterationExponent ?? 1,
    identifier,
    extendable: params.extendable ?? true,
  };
  const encrypted = await encrypt(params.masterSecret, cipher);
  const groupShares = splitSecret(
    params.groupThreshold,
    params.groups.length,
    encrypted,
    random,
  );
  return params.groups.map(([memberThreshold, memberCount], groupIndex) => {
    const group = groupShares[groupIndex];
    if (!group) throw new Slip39Error("group share missing");
    return splitSecret(memberThreshold, memberCount, group.y, random).map(
      (member) =>
        encodeShare({
          identifier,
          extendable: cipher.extendable,
          iterationExponent: cipher.iterationExponent,
          groupIndex,
          groupThreshold: params.groupThreshold,
          groupCount: params.groups.length,
          memberIndex: member.x,
          memberThreshold,
          value: member.y,
        }),
    );
  });
}

type Common = Pick<
  ShareFields,
  | "identifier"
  | "extendable"
  | "iterationExponent"
  | "groupThreshold"
  | "groupCount"
>;

function sameCommon(a: ShareFields, b: Common): boolean {
  return (
    a.identifier === b.identifier &&
    a.extendable === b.extendable &&
    a.iterationExponent === b.iterationExponent &&
    a.groupThreshold === b.groupThreshold &&
    a.groupCount === b.groupCount
  );
}

function groupShares(
  shares: readonly ShareFields[],
): Map<number, ShareFields[]> {
  const groups = new Map<number, ShareFields[]>();
  for (const share of shares) {
    const list = groups.get(share.groupIndex) ?? [];
    list.push(share);
    groups.set(share.groupIndex, list);
  }
  return groups;
}

function checkGroup(members: readonly ShareFields[]): void {
  const first = members[0];
  if (!first) throw new Slip39Error("empty group");
  if (members.some((m) => m.memberThreshold !== first.memberThreshold)) {
    throw new Slip39Error("mismatching member thresholds in a group");
  }
  if (new Set(members.map((m) => m.memberIndex)).size !== members.length) {
    throw new Slip39Error("duplicate member index in a group");
  }
  if (members.length !== first.memberThreshold) {
    throw new Slip39Error(
      `a group needs exactly ${first.memberThreshold} shares, not ${members.length}`,
    );
  }
}

function checkShares(shares: readonly ShareFields[]): Common {
  const first = shares[0];
  if (!first) throw new Slip39Error("the list of mnemonics is empty");
  if (!shares.every((s) => sameCommon(s, first))) {
    throw new Slip39Error(
      "the mnemonics do not share an identifier, exponent and group layout",
    );
  }
  if (!shares.every((s) => s.value.length === first.value.length)) {
    throw new Slip39Error("the shares differ in length");
  }
  return first;
}

export type CombineOptions = Readonly<{
  passphrase?: string;
  /** Refuse a share that asks for more PBKDF2 work than this. */
  maxIterationExponent?: number;
}>;

/** CombineShares: exactly the threshold of groups, each with exactly its threshold of members. */
export async function combineMnemonics(
  mnemonics: readonly string[],
  options: CombineOptions = {},
): Promise<Uint8Array> {
  const shares = mnemonics.map(decodeShare);
  const common = checkShares(shares);
  const groups = groupShares(shares);
  if (groups.size !== common.groupThreshold) {
    throw new Slip39Error(
      `expected ${common.groupThreshold} groups, got ${groups.size}`,
    );
  }
  const groupPoints = [...groups.entries()].map(([x, members]) => {
    checkGroup(members);
    const threshold = members[0]?.memberThreshold ?? 1;
    return {
      x,
      y: recoverSecret(
        threshold,
        members.map((m) => ({ x: m.memberIndex, y: m.value })),
      ),
    };
  });
  const encrypted = recoverSecret(common.groupThreshold, groupPoints);
  return decrypt(encrypted, {
    passphrase: options.passphrase ?? "",
    iterationExponent: common.iterationExponent,
    identifier: common.identifier,
    extendable: common.extendable,
    maxIterationExponent: options.maxIterationExponent,
  });
}

/** The non-secret header of a mnemonic, for sorting a pile of shares into sets. */
export function describeMnemonic(mnemonic: string): Omit<ShareFields, "value"> {
  const { value: _value, ...header } = decodeShare(mnemonic);
  return header;
}
