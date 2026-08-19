import { describe, expect, it } from "vitest";
import {
  DomainError,
  authenticateClaim,
  canElevateAssurance,
  canTransitionClaim,
  completeClaim,
  denyClaim,
  expireClaim,
  maybeExpireClaim,
  presentClaim,
  reviewClaim,
  revokeClaim,
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

describe("claim machine expiry guards", () => {
  it("rejects operations on a session already in the expired state", () => {
    const expired = expireClaim(fixtures.pendingClaim().session, fixtures.now);
    expectDomainError(() => presentClaim(expired, fixtures.now), "EXPIRED");
  });

  it("reports EXPIRED with details when the clock is past expiresAt", () => {
    const { session } = fixtures.pendingClaim({
      expiresAt: new Date(fixtures.now.getTime() - 1),
    });
    try {
      presentClaim(session, fixtures.now);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as DomainError).code).toBe("EXPIRED");
      expect((err as DomainError).details).toMatchObject({ id: session.id });
    }
  });

  it("still reports INVALID_TRANSITION (not EXPIRED) for terminal sessions past TTL", () => {
    let s = fixtures.pendingClaim({
      expiresAt: new Date(fixtures.now.getTime() - 1),
    }).session;
    s = presentClaim(s, new Date(fixtures.now.getTime() - 5000));
    s = authenticateClaim(s, new Date(fixtures.now.getTime() - 4000));
    s = reviewClaim(s, {}, new Date(fixtures.now.getTime() - 3000));
    const completed = completeClaim(
      s,
      "prn_claimer",
      new Date(fixtures.now.getTime() - 2000),
    );
    expectDomainError(
      () => presentClaim(completed, fixtures.now),
      "INVALID_TRANSITION",
    );
  });
});

describe("claim machine transition guards", () => {
  it("rejects completeClaim from any state but reviewed", () => {
    const pending = fixtures.pendingClaim().session;
    expectDomainError(
      () => completeClaim(pending, "prn_x", fixtures.now),
      "INVALID_TRANSITION",
    );
    const presented = presentClaim(
      fixtures.pendingClaim().session,
      fixtures.now,
    );
    expectDomainError(
      () => completeClaim(presented, "prn_x", fixtures.now),
      "INVALID_TRANSITION",
    );
  });

  it("rejects revoke from completed/denied and re-revoke", () => {
    const denied = denyClaim(
      reviewClaim(
        authenticateClaim(
          presentClaim(fixtures.pendingClaim().session, fixtures.now),
          fixtures.now,
        ),
        {},
        fixtures.now,
      ),
      fixtures.now,
    );
    expectDomainError(
      () => revokeClaim(denied, fixtures.now),
      "INVALID_TRANSITION",
    );

    const revoked = revokeClaim(fixtures.pendingClaim().session, fixtures.now);
    expectDomainError(
      () => revokeClaim(revoked, fixtures.now),
      "INVALID_TRANSITION",
    );
  });

  it("rejects expire from terminal states and re-expire", () => {
    const denied = denyClaim(
      reviewClaim(
        authenticateClaim(
          presentClaim(fixtures.pendingClaim().session, fixtures.now),
          fixtures.now,
        ),
        {},
        fixtures.now,
      ),
      fixtures.now,
    );
    expectDomainError(
      () => expireClaim(denied, fixtures.now),
      "INVALID_TRANSITION",
    );

    const expired = expireClaim(fixtures.pendingClaim().session, fixtures.now);
    expectDomainError(
      () => expireClaim(expired, fixtures.now),
      "INVALID_TRANSITION",
    );
  });

  it("deny from reviewed stamps completedAt", () => {
    const reviewed = reviewClaim(
      authenticateClaim(
        presentClaim(fixtures.pendingClaim().session, fixtures.now),
        fixtures.now,
      ),
      { acceptedItemIds: [] },
      fixtures.now,
    );
    const denied = denyClaim(reviewed, fixtures.now);
    expect(denied.state).toBe("denied");
    expect(denied.completedAt).toEqual(fixtures.now);
    expect(denied.reviewDecision).toEqual({ acceptedItemIds: [] });
  });

  it("revoke stamps revokedAt and bumps the version", () => {
    const pending = fixtures.pendingClaim().session;
    const revoked = revokeClaim(pending, fixtures.now);
    expect(revoked.revokedAt).toEqual(fixtures.now);
    expect(revoked.version).toBe(pending.version + 1);
  });

  it("reports false for unknown claim states in canTransitionClaim", () => {
    // @ts-expect-error deliberate out-of-union probe
    expect(canTransitionClaim("archived", "pending")).toBe(false);
  });
});

describe("maybeExpireClaim", () => {
  it("returns terminal sessions unchanged", () => {
    const revoked = revokeClaim(fixtures.pendingClaim().session, fixtures.now);
    const result = maybeExpireClaim(
      revoked,
      () => new Date(fixtures.now.getTime() + 3_600_000),
    );
    expect(result).toBe(revoked);
  });

  it("returns unexpired sessions unchanged", () => {
    const { session } = fixtures.pendingClaim();
    expect(maybeExpireClaim(session, () => fixtures.now)).toBe(session);
  });

  it("expires sessions past their TTL", () => {
    const { session } = fixtures.pendingClaim();
    const expired = maybeExpireClaim(
      session,
      () => new Date(session.expiresAt.getTime() + 1),
    );
    expect(expired.state).toBe("expired");
    expect(expired.version).toBe(session.version + 1);
  });

  it("defaults to the wall clock", () => {
    const { session } = fixtures.pendingClaim({
      expiresAt: new Date(Date.now() - 1),
    });
    expect(maybeExpireClaim(session).state).toBe("expired");
  });
});

describe("canElevateAssurance", () => {
  it("always allows staying at the current level", () => {
    for (const level of [
      "provisional",
      "self_asserted",
      "verified",
      "mfa",
      "phishing_resistant",
      "enterprise_managed",
      "workload_attested",
    ] as const) {
      expect(canElevateAssurance(level, level)).toBe(true);
    }
  });

  it("allows provisional -> self_asserted | verified only", () => {
    expect(canElevateAssurance("provisional", "self_asserted")).toBe(true);
    expect(canElevateAssurance("provisional", "verified")).toBe(true);
    expect(canElevateAssurance("provisional", "mfa")).toBe(false);
    expect(canElevateAssurance("provisional", "phishing_resistant")).toBe(
      false,
    );
  });

  it("allows self_asserted -> verified only", () => {
    expect(canElevateAssurance("self_asserted", "verified")).toBe(true);
    expect(canElevateAssurance("self_asserted", "mfa")).toBe(false);
    expect(canElevateAssurance("self_asserted", "provisional")).toBe(false);
  });

  it("allows verified -> mfa | phishing_resistant | enterprise_managed | workload_attested", () => {
    expect(canElevateAssurance("verified", "mfa")).toBe(true);
    expect(canElevateAssurance("verified", "phishing_resistant")).toBe(true);
    expect(canElevateAssurance("verified", "enterprise_managed")).toBe(true);
    expect(canElevateAssurance("verified", "workload_attested")).toBe(true);
    expect(canElevateAssurance("verified", "self_asserted")).toBe(false);
  });

  it("allows mfa -> phishing_resistant | enterprise_managed only", () => {
    expect(canElevateAssurance("mfa", "phishing_resistant")).toBe(true);
    expect(canElevateAssurance("mfa", "enterprise_managed")).toBe(true);
    expect(canElevateAssurance("mfa", "verified")).toBe(false);
    expect(canElevateAssurance("mfa", "workload_attested")).toBe(false);
  });

  it("falls back to strict ordering for the remaining levels", () => {
    expect(
      canElevateAssurance("phishing_resistant", "enterprise_managed"),
    ).toBe(true);
    expect(canElevateAssurance("phishing_resistant", "workload_attested")).toBe(
      true,
    );
    expect(canElevateAssurance("enterprise_managed", "workload_attested")).toBe(
      true,
    );
    expect(
      canElevateAssurance("enterprise_managed", "phishing_resistant"),
    ).toBe(false);
    expect(canElevateAssurance("workload_attested", "enterprise_managed")).toBe(
      false,
    );
  });
});
