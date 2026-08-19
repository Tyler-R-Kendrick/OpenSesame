import { describe, expect, it } from "vitest";
import {
  DomainError,
  approveDeviceAuth,
  canTransitionDeviceAuth,
  consumeDeviceAuth,
  denyDeviceAuth,
  expireDeviceAuth,
  recordDevicePoll,
} from "../index.js";
import { fixtures } from "./fixtures.js";

describe("device authorization state machine", () => {
  it("allows pending→approved→consumed", () => {
    const pending = fixtures.pendingDeviceAuth();
    const approved = approveDeviceAuth(pending, "prn_user", fixtures.now);
    expect(approved.state).toBe("approved");
    expect(approved.approvedByPrincipalId).toBe("prn_user");
    const consumed = consumeDeviceAuth(approved, fixtures.now);
    expect(consumed.state).toBe("consumed");
    expect(consumed.consumedAt).toEqual(fixtures.now);
  });

  it("allows pending→denied and pending→expired", () => {
    expect(
      denyDeviceAuth(fixtures.pendingDeviceAuth(), fixtures.now).state,
    ).toBe("denied");
    expect(
      expireDeviceAuth(fixtures.pendingDeviceAuth(), fixtures.now).state,
    ).toBe("expired");
  });

  it("rejects invalid transitions", () => {
    const pending = fixtures.pendingDeviceAuth();
    expect(() => consumeDeviceAuth(pending, fixtures.now)).toThrow(DomainError);
    const denied = denyDeviceAuth(pending, fixtures.now);
    expect(() => approveDeviceAuth(denied, "prn_x", fixtures.now)).toThrow(
      DomainError,
    );
    expect(canTransitionDeviceAuth("consumed", "pending")).toBe(false);
  });

  it("rejects ops after expiry by clock", () => {
    const s = fixtures.pendingDeviceAuth({
      expiresAt: new Date(fixtures.now.getTime() - 1),
    });
    expect(() => approveDeviceAuth(s, "prn_x", fixtures.now)).toThrow(
      DomainError,
    );
  });

  it("records polls without changing state", () => {
    const s = fixtures.pendingDeviceAuth();
    const polled = recordDevicePoll(s, fixtures.now);
    expect(polled.state).toBe("pending");
    expect(polled.pollCount).toBe(1);
    expect(polled.lastPolledAt).toEqual(fixtures.now);
  });
});
