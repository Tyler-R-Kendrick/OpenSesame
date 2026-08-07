import { describe, expect, it } from "vitest";
import { approveDeviceAuth, fixtures } from "@opensesame/os-domain";
import {
  applySlowDown,
  evaluateDevicePoll,
  initialPollInterval,
  projectDeviceAuth,
  shouldSlowDown,
} from "../index.js";

describe("device-auth projections", () => {
  it("projects safe UI/audit fields without digests", () => {
    const s = fixtures.pendingDeviceAuth();
    const p = projectDeviceAuth(s);
    expect(p.id).toBe(s.id);
    expect(p.state).toBe("pending");
    expect(JSON.stringify(p)).not.toContain("Digest");
  });

  it("bumps poll interval on slow_down", () => {
    const state = initialPollInterval(5);
    const next = applySlowDown(state, 5);
    expect(next.intervalSeconds).toBe(10);
    expect(next.slowDownCount).toBe(1);
  });

  it("detects premature polls", () => {
    const s = fixtures.pendingDeviceAuth({
      lastPolledAt: fixtures.now,
      intervalSeconds: 5,
    });
    expect(shouldSlowDown(s, new Date(fixtures.now.getTime() + 1000))).toBe(
      true,
    );
    expect(shouldSlowDown(s, new Date(fixtures.now.getTime() + 6000))).toBe(
      false,
    );
  });

  it("returns RFC 8628 poll errors", () => {
    const pending = fixtures.pendingDeviceAuth();
    const r1 = evaluateDevicePoll(pending, () => fixtures.now);
    expect(r1.error).toBe("authorization_pending");

    const tooFast = evaluateDevicePoll(r1.session, () => fixtures.now);
    expect(tooFast.error).toBe("slow_down");

    const approved = approveDeviceAuth(pending, "prn_x", fixtures.now);
    const r2 = evaluateDevicePoll(approved, () => fixtures.now);
    expect(r2.error).toBeUndefined();
    expect(r2.projection.state).toBe("approved");

    const expired = fixtures.pendingDeviceAuth({
      expiresAt: new Date(fixtures.now.getTime() - 1),
    });
    const r3 = evaluateDevicePoll(expired, () => fixtures.now);
    expect(r3.error).toBe("expired_token");
  });
});
