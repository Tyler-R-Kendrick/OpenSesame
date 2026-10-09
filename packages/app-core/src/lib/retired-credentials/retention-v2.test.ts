import { expect, it } from "vitest";
import profile from "../../../../../spec/conformance/retired-retention-v2.json";
import {
  DEFAULT_RETIRED_RETENTION_MS,
  MAX_RETIRED_RETENTION_MS,
  assertRetiredTrapRetention,
  isRetiredTrapLive,
  retiredTrapExpiresAt,
} from "./retention-v2.js";
it.each(profile.valid)("shared $name retention boundary", (v) => {
  expect(() =>
    assertRetiredTrapRetention(v.createdAt, v.expiresAt),
  ).not.toThrow();
  expect(isRetiredTrapLive(v.createdAt, v.expiresAt, v.nowMs)).toBe(v.live);
});
it.each(profile.invalid)(
  "shared malformed retention refuses $createdAt $expiresAt",
  (v) => {
    expect(() =>
      assertRetiredTrapRetention(v.createdAt, v.expiresAt),
    ).toThrow();
  },
);
it("uses the shared default/max and accepts deliberate shorter retention", () => {
  expect(DEFAULT_RETIRED_RETENTION_MS).toBe(profile.defaultLifetimeMs);
  expect(MAX_RETIRED_RETENTION_MS).toBe(profile.maxLifetimeMs);
  expect(retiredTrapExpiresAt(required(profile.valid[0]).createdAt)).toBe(
    required(profile.valid[0]).expiresAt,
  );
  expect(retiredTrapExpiresAt(required(profile.valid[0]).createdAt, 1)).toBe(
    required(profile.valid[2]).expiresAt,
  );
  for (const bad of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0.5,
    MAX_RETIRED_RETENTION_MS + 1,
  ])
    expect(() =>
      retiredTrapExpiresAt(required(profile.valid[0]).createdAt, bad),
    ).toThrow();
});
it("refuses invalid local clock and expiry overflowing canonical four-digit years", () => {
  for (const bad of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0.5,
    Number.MAX_SAFE_INTEGER,
  ])
    expect(() =>
      isRetiredTrapLive(
        required(profile.valid[0]).createdAt,
        required(profile.valid[0]).expiresAt,
        bad,
      ),
    ).toThrow();
  expect(() => retiredTrapExpiresAt("9999-12-31T23:59:59.999Z", 1)).toThrow();
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing genuine fixture value.");
  return value;
}
