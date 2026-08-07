import { describe, expect, it } from "vitest";
import {
  authenticateClaim,
  canTransitionClaim,
  completeClaim,
  denyClaim,
  DomainError,
  expireClaim,
  presentClaim,
  reviewClaim,
  revokeClaim,
} from "../index.js";
import { fixtures } from "./fixtures.js";

describe("claim state machine", () => {
  it("allows the happy path pending→…→completed", () => {
    const { session } = fixtures.pendingClaim();
    const presented = presentClaim(session, fixtures.now);
    expect(presented.state).toBe("presented");
    expect(presented.version).toBe(session.version + 1);

    const authenticated = authenticateClaim(presented, fixtures.now);
    expect(authenticated.state).toBe("authenticated");

    const reviewed = reviewClaim(
      authenticated,
      { acceptedItemIds: ["ci_project"] },
      fixtures.now,
    );
    expect(reviewed.state).toBe("reviewed");

    const completed = completeClaim(reviewed, "prn_claimer", fixtures.now);
    expect(completed.state).toBe("completed");
    expect(completed.completedByPrincipalId).toBe("prn_claimer");
    expect(completed.targetManifestDigest).toBe(session.targetManifestDigest);
  });

  it("allows deny from reviewed", () => {
    let s = fixtures.pendingClaim().session;
    s = presentClaim(s, fixtures.now);
    s = authenticateClaim(s, fixtures.now);
    s = reviewClaim(s, {}, fixtures.now);
    const denied = denyClaim(s, fixtures.now);
    expect(denied.state).toBe("denied");
  });

  it("allows revoke/expire from non-terminal states", () => {
    const pending = fixtures.pendingClaim().session;
    expect(revokeClaim(pending, fixtures.now).state).toBe("revoked");
    expect(expireClaim(fixtures.pendingClaim().session, fixtures.now).state).toBe(
      "expired",
    );

    let s = presentClaim(fixtures.pendingClaim().session, fixtures.now);
    expect(revokeClaim(s, fixtures.now).state).toBe("revoked");
    s = presentClaim(fixtures.pendingClaim().session, fixtures.now);
    expect(expireClaim(s, fixtures.now).state).toBe("expired");
  });

  it("rejects invalid transitions", () => {
    const pending = fixtures.pendingClaim().session;
    expect(() => authenticateClaim(pending, fixtures.now)).toThrow(DomainError);
    expect(() => completeClaim(pending, "prn_x", fixtures.now)).toThrow(
      DomainError,
    );

    let s = presentClaim(pending, fixtures.now);
    s = authenticateClaim(s, fixtures.now);
    s = reviewClaim(s, {}, fixtures.now);
    const completed = completeClaim(s, "prn_x", fixtures.now);
    expect(() => revokeClaim(completed, fixtures.now)).toThrow(DomainError);
    expect(() => presentClaim(completed, fixtures.now)).toThrow(DomainError);
    expect(canTransitionClaim("completed", "pending")).toBe(false);
  });

  it("rejects operations on expired claims by clock", () => {
    const { session } = fixtures.pendingClaim({
      expiresAt: new Date(fixtures.now.getTime() - 1),
    });
    expect(() => presentClaim(session, fixtures.now)).toThrow(DomainError);
  });

  it("preserves immutable manifest digest across transitions", () => {
    const { session } = fixtures.pendingClaim();
    const digest = session.targetManifestDigest;
    let s = presentClaim(session, fixtures.now);
    s = authenticateClaim(s, fixtures.now);
    s = reviewClaim(s, {}, fixtures.now);
    s = completeClaim(s, "prn_x", fixtures.now);
    expect(s.targetManifestDigest).toBe(digest);
  });
});
