/**
 * The reason vocabulary's sets and order pinned exactly (carried from #470,
 * whose reason-literal tests let its mutation slice reach 100).
 */
import { describe, expect, it } from "vitest";
import {
  BLOCKING_REASONS,
  CONSENT_ONLY_REASONS,
  REASON_CODES,
  sortReasons,
} from "./reasons.js";

describe("reason sets", () => {
  it("blocking reasons are exactly the ceiling, runtime and network codes", () => {
    expect([...BLOCKING_REASONS]).toEqual([
      "NOT_DISTRIBUTED",
      "POLICY_UNVERIFIED",
      "PROFILE_MISMATCH",
      "PROHIBITED_BY_INSTANCE",
      "NOT_PERMITTED_BY_INSTANCE",
      "DENIED_BY_WORKSPACE",
      "DISABLED_IN_VAULT",
      "UNSUPPORTED_RUNTIME",
      "NETWORK_POLICY_DENIES",
      "WORKER_GRAPH_UNAVAILABLE",
    ]);
  });

  it("consent-only reasons are consent and restart", () => {
    expect([...CONSENT_ONLY_REASONS]).toEqual([
      "CONSENT_REQUIRED",
      "RESTART_REQUIRED",
    ]);
  });
});

describe("sortReasons", () => {
  it("puts any order back into vocabulary order and drops repeats", () => {
    const shuffled = [...REASON_CODES].reverse();
    expect(sortReasons([...shuffled, ...shuffled])).toEqual([...REASON_CODES]);
  });

  it("orders a pair by position, not by name", () => {
    expect(sortReasons(["RESTART_REQUIRED", "CORE"])).toEqual([
      "CORE",
      "RESTART_REQUIRED",
    ]);
    expect(sortReasons(["NOT_SELECTED", "DISABLED_IN_VAULT"])).toEqual([
      "DISABLED_IN_VAULT",
      "NOT_SELECTED",
    ]);
  });
});
