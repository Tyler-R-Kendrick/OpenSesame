/**
 * GA-V-34 / INV-GA-08 — one stored authority model, one name.
 *
 * GA-O-03 decided the durable record is Grant / AuthorityGrant. AccessLease is
 * UI vocabulary only and must not appear as a second exported domain type.
 */

import { describe, expect, it } from "vitest";
import type { AuthorityGrant, AuthorityRecord } from "../authority-grant.js";
import * as domain from "../index.js";

describe("authority naming (GA-V-34)", () => {
  it("exports AuthorityGrant as the sole stored authority record alias", () => {
    type Same = AuthorityRecord extends AuthorityGrant
      ? AuthorityGrant extends AuthorityRecord
        ? true
        : false
      : false;
    const same: Same = true;
    expect(same).toBe(true);
  });

  it("does not export an AccessLease domain type beside AuthorityGrant", () => {
    const exported = Object.keys(domain);
    expect(exported).not.toContain("AccessLease");
    expect(exported.some((name) => name.includes("AccessLease"))).toBe(false);
  });
});