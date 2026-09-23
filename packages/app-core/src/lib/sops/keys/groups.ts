/**
 * Key-group semantics of upstream `Metadata.GetDataKeyWithKeyServices` and
 * `UpdateMasterKeysWithKeyServices` (sops.go, 26e2f478), with bounded,
 * deterministic scheduling (B08):
 *
 *  - one group: every member wraps the whole 32-byte data key;
 *  - several groups: each group wraps one 33-byte Shamir share, and
 *    `shamir_threshold` distinct groups must open (0 means every group);
 *  - a group counts once no matter how many of its members open;
 *  - local identities are tried before any provider, groups in order, and
 *    work stops once the threshold is met.
 */

import { SopsError } from "../errors.js";
import { DATA_KEY_BYTES, SHARE_BYTES } from "../limits.js";
import { effectiveThreshold } from "../metadata-emit.js";
import type { SopsKeyGroup, SopsMasterKey, SopsMetadata } from "../metadata.js";
import { shamirCombine, shamirSplit } from "../shamir.js";
import { unwrapAge, wrapAge } from "./age.js";

/** An approved way to open or write a non-age wrapper (cloud providers). */
export type MasterKeyProvider = {
  kind: SopsMasterKey["kind"];
  /** Returns the payload or null when this provider cannot open the key. */
  unwrap(key: SopsMasterKey, signal: AbortSignal): Promise<Uint8Array | null>;
  wrap(
    key: SopsMasterKey,
    payload: Uint8Array,
    signal: AbortSignal,
  ): Promise<SopsMasterKey>;
};

export type RecoveryInput = {
  identities: readonly string[];
  providers: readonly MasterKeyProvider[];
  signal: AbortSignal;
};

export type GroupOutcome =
  | "opened"
  | "no_identity"
  | "provider_unavailable"
  | "malformed";

export type RecoveryReport = {
  outcomes: GroupOutcome[];
  openedGroups: number;
  required: number;
};

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new SopsError("canceled", "The SOPS operation was canceled.");
}

type GroupAttempt = { payload: Uint8Array | null; outcome: GroupOutcome };

async function openGroup(
  group: SopsKeyGroup,
  expected: number,
  input: RecoveryInput,
): Promise<GroupAttempt> {
  let outcome: GroupOutcome = "no_identity";
  // Upstream's default decryption order: age, then pgp, then the rest.
  const ordered = [...group.keys].sort((a, b) => rank(a) - rank(b));
  for (const key of ordered) {
    throwIfAborted(input.signal);
    if (key.kind === "age") {
      const result = await unwrapAge(key.enc, input.identities);
      if (result.status === "opened") {
        if (result.payload.byteLength !== expected) {
          result.payload.fill(0);
          return { payload: null, outcome: "malformed" };
        }
        return { payload: result.payload, outcome: "opened" };
      }
      if (result.status === "malformed") outcome = "malformed";
      continue;
    }
    const provider = input.providers.find(
      (candidate) => candidate.kind === key.kind,
    );
    if (!provider) continue;
    let payload: Uint8Array | null;
    try {
      payload = await provider.unwrap(key, input.signal);
    } catch (caught) {
      if (caught instanceof SopsError && caught.code === "canceled")
        throw caught;
      outcome = "provider_unavailable";
      continue;
    }
    if (payload) {
      if (payload.byteLength !== expected) {
        payload.fill(0);
        return { payload: null, outcome: "malformed" };
      }
      return { payload, outcome: "opened" };
    }
    outcome = "provider_unavailable";
  }
  return { payload: null, outcome };
}

function rank(key: SopsMasterKey): number {
  if (key.kind === "age") return 0;
  if (key.kind === "pgp") return 1;
  return 2;
}

/** Turn the per-group outcomes into the one typed reason to report. */
function recoveryFailure(
  outcomes: readonly GroupOutcome[],
  groups: number,
  opened: number,
): SopsError {
  if (outcomes.includes("malformed")) {
    return new SopsError(
      "malformed_encoding",
      "A key group holds a malformed wrapper.",
    );
  }
  if (groups > 1 && opened > 0) {
    return new SopsError(
      "insufficient_groups",
      "Not enough distinct key groups could be opened.",
    );
  }
  if (outcomes.includes("provider_unavailable")) {
    return new SopsError(
      "provider_unavailable",
      "A key provider could not be reached from this browser.",
    );
  }
  return new SopsError(
    "missing_identity",
    "No supplied identity opens any key group.",
  );
}

/** Distinct, non-zero share coordinates, as upstream's combine requires. */
function assertDistinctShares(shares: readonly Uint8Array[]): void {
  const seen = new Set<number>();
  for (const share of shares) {
    const coordinate = share[SHARE_BYTES - 1] ?? 0;
    if (coordinate === 0 || seen.has(coordinate)) {
      throw new SopsError(
        "malformed_encoding",
        "Key groups repeat a share coordinate.",
      );
    }
    seen.add(coordinate);
  }
}

/**
 * Recover the document data key or fail with a typed reason. Every share
 * buffer is zeroed on exit; the returned key belongs to the caller.
 */
export type RecoveredDataKey = { key: Uint8Array; report: RecoveryReport };

export async function recoverDataKey(
  meta: SopsMetadata,
  input: RecoveryInput,
): Promise<RecoveredDataKey> {
  const groups = meta.groups;
  const required = effectiveThreshold(meta);
  const expected = groups.length > 1 ? SHARE_BYTES : DATA_KEY_BYTES;
  const shares: Uint8Array[] = [];
  const outcomes: GroupOutcome[] = [];
  try {
    for (const group of groups) {
      if (shares.length >= required) break;
      const opened = await openGroup(group, expected, input);
      outcomes.push(opened.outcome);
      if (opened.payload) shares.push(opened.payload);
    }
    const report: RecoveryReport = {
      outcomes,
      openedGroups: shares.length,
      required,
    };
    if (shares.length < required)
      throw recoveryFailure(outcomes, groups.length, shares.length);
    let key: Uint8Array;
    if (groups.length === 1) {
      const only = shares[0];
      if (!only)
        throw new SopsError(
          "missing_identity",
          "No supplied identity opens the key group.",
        );
      key = new Uint8Array(only);
    } else {
      assertDistinctShares(shares);
      key = shamirCombine(shares);
    }
    if (key.byteLength !== DATA_KEY_BYTES) {
      key.fill(0);
      throw new SopsError(
        "malformed_encoding",
        "The recovered data key has the wrong length.",
      );
    }
    return { key, report };
  } finally {
    for (const share of shares) share.fill(0);
  }
}

export type WrapTarget = { kind: "age"; recipient: string } | ForeignTarget;
export type ForeignTarget = {
  kind: Exclude<SopsMasterKey["kind"], "age">;
  template: SopsMasterKey;
};

/**
 * Wrap a fresh data key for every target in every group (B08, all or
 * nothing). Returns the groups in order; any failure aborts the whole write.
 */
export async function wrapDataKey(
  key: Uint8Array,
  groups: readonly (readonly WrapTarget[])[],
  threshold: number,
  providers: readonly MasterKeyProvider[],
  signal: AbortSignal,
): Promise<SopsKeyGroup[]> {
  if (groups.length === 0)
    throw new SopsError(
      "invalid_recipient",
      "At least one key group is required.",
    );
  const parts =
    groups.length === 1 ? [key] : shamirSplit(key, groups.length, threshold);
  try {
    const out: SopsKeyGroup[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const targets = groups[index] ?? [];
      const part = parts[index];
      if (!part || targets.length === 0) {
        throw new SopsError(
          "invalid_recipient",
          "A key group has no recipients.",
        );
      }
      const keys: SopsMasterKey[] = [];
      for (const target of targets) {
        throwIfAborted(signal);
        if (target.kind === "age") {
          keys.push({
            kind: "age",
            recipient: target.recipient,
            enc: await wrapAge(part, target.recipient),
          });
          continue;
        }
        const provider = providers.find(
          (candidate) => candidate.kind === target.kind,
        );
        if (!provider) {
          throw new SopsError(
            "provider_unavailable",
            "A selected key provider is not available in this browser.",
          );
        }
        keys.push(await provider.wrap(target.template, part, signal));
      }
      out.push({ keys });
    }
    return out;
  } finally {
    if (groups.length > 1) for (const part of parts) part.fill(0);
  }
}
