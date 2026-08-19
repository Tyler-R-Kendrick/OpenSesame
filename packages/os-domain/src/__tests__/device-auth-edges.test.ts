import { describe, expect, it } from "vitest";
import {
  DomainError,
  approveDeviceAuth,
  consumeDeviceAuth,
  denyDeviceAuth,
  expireDeviceAuth,
  maybeExpireDeviceAuth,
  recordDevicePoll,
} from "../index.js";
import { fixtures } from "./fixtures.js";

const expectDomainError = (fn: () => unknown, code: string) => {
  try {
    fn();
    expect.unreachable("should have thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
  }
};

describe("device authorization expiry guards", () => {
  it("rejects operations on an already-expired session", () => {
    const expired = expireDeviceAuth(
      fixtures.pendingDeviceAuth(),
      fixtures.now,
    );
    expectDomainError(
      () => approveDeviceAuth(expired, "prn_x", fixtures.now),
      "EXPIRED",
    );
  });

  it("rejects approval once the clock is past expiresAt", () => {
    const s = fixtures.pendingDeviceAuth({
      expiresAt: new Date(fixtures.now.getTime() - 1),
    });
    try {
      approveDeviceAuth(s, "prn_x", fixtures.now);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as DomainError).code).toBe("EXPIRED");
      expect((err as DomainError).details).toMatchObject({ id: s.id });
    }
  });

  it("rejects consumption of an approved session that has since expired", () => {
    const approved = approveDeviceAuth(
      fixtures.pendingDeviceAuth(),
      "prn_x",
      fixtures.now,
    );
    expectDomainError(
      () =>
        consumeDeviceAuth(approved, new Date(approved.expiresAt.getTime() + 1)),
      "EXPIRED",
    );
  });
});

describe("device authorization transition guards", () => {
  it("rejects deny from approved", () => {
    const approved = approveDeviceAuth(
      fixtures.pendingDeviceAuth(),
      "prn_x",
      fixtures.now,
    );
    expectDomainError(
      () => denyDeviceAuth(approved, fixtures.now),
      "INVALID_TRANSITION",
    );
  });

  it("rejects expire from denied/consumed and re-expire", () => {
    const denied = denyDeviceAuth(fixtures.pendingDeviceAuth(), fixtures.now);
    expectDomainError(
      () => expireDeviceAuth(denied, fixtures.now),
      "INVALID_TRANSITION",
    );

    const consumed = consumeDeviceAuth(
      approveDeviceAuth(fixtures.pendingDeviceAuth(), "prn_x", fixtures.now),
      fixtures.now,
    );
    expectDomainError(
      () => expireDeviceAuth(consumed, fixtures.now),
      "INVALID_TRANSITION",
    );

    const expired = expireDeviceAuth(
      fixtures.pendingDeviceAuth(),
      fixtures.now,
    );
    expectDomainError(
      () => expireDeviceAuth(expired, fixtures.now),
      "INVALID_TRANSITION",
    );
  });

  it("keeps code digests immutable across transitions", () => {
    const pending = fixtures.pendingDeviceAuth();
    const approved = approveDeviceAuth(pending, "prn_x", fixtures.now);
    expect(approved.deviceCodeDigest).toBe(pending.deviceCodeDigest);
    expect(approved.userCodeDigest).toBe(pending.userCodeDigest);
    expect(approved.id).toBe(pending.id);
  });
});

describe("maybeExpireDeviceAuth", () => {
  it("returns terminal sessions unchanged", () => {
    const denied = denyDeviceAuth(fixtures.pendingDeviceAuth(), fixtures.now);
    expect(
      maybeExpireDeviceAuth(
        denied,
        () => new Date(fixtures.now.getTime() + 3_600_000),
      ),
    ).toBe(denied);
  });

  it("returns live sessions unchanged before expiry", () => {
    const s = fixtures.pendingDeviceAuth();
    expect(maybeExpireDeviceAuth(s, () => fixtures.now)).toBe(s);
  });

  it("expires approved sessions past their TTL", () => {
    const approved = approveDeviceAuth(
      fixtures.pendingDeviceAuth(),
      "prn_x",
      fixtures.now,
    );
    const expired = maybeExpireDeviceAuth(
      approved,
      () => new Date(approved.expiresAt.getTime() + 1),
    );
    expect(expired.state).toBe("expired");
  });

  it("defaults to the wall clock", () => {
    const s = fixtures.pendingDeviceAuth({
      expiresAt: new Date(Date.now() - 1),
    });
    expect(maybeExpireDeviceAuth(s).state).toBe("expired");
  });
});

describe("recordDevicePoll", () => {
  it("accumulates poll counts", () => {
    let s = fixtures.pendingDeviceAuth();
    s = recordDevicePoll(s, fixtures.now);
    s = recordDevicePoll(s, new Date(fixtures.now.getTime() + 5000));
    expect(s.pollCount).toBe(2);
    expect(s.lastPolledAt).toEqual(new Date(fixtures.now.getTime() + 5000));
  });
});
