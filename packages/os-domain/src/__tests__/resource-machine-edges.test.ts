import { describe, expect, it } from "vitest";
import {
  DomainError,
  activateProvisionalResource,
  beginResourceDeletion,
  canTransitionResource,
  completeResourceDeletion,
  maybeExpireProvisionalResource,
  quarantineResource,
} from "../index.js";
import { fixtures } from "./fixtures.js";

describe("provisional resource machine edges", () => {
  it("allows active->expired, active->deleting, active->quarantined", () => {
    const active = activateProvisionalResource(
      fixtures.provisionalResource(),
      fixtures.now,
    );
    expect(beginResourceDeletion(active, fixtures.now).state).toBe("deleting");
    expect(
      quarantineResource(
        activateProvisionalResource(
          fixtures.provisionalResource(),
          fixtures.now,
        ),
        fixtures.now,
      ).state,
    ).toBe("quarantined");
  });

  it("allows quarantined->deleting and quarantined->expired", () => {
    const quarantined = quarantineResource(
      fixtures.provisionalResource(),
      fixtures.now,
    );
    expect(beginResourceDeletion(quarantined, fixtures.now).state).toBe(
      "deleting",
    );
    expect(
      maybeExpireProvisionalResource(
        quarantineResource(
          fixtures.provisionalResource({
            expiresAt: new Date(fixtures.now.getTime() - 1),
          }),
          fixtures.now,
        ),
        () => fixtures.now,
      ).state,
    ).toBe("quarantined"); // maybeExpire only touches provisional/active
    expect(canTransitionResource("quarantined", "expired")).toBe(true);
  });

  it("bumps version and stamps updatedAt on each transition", () => {
    const r = fixtures.provisionalResource();
    const later = new Date(fixtures.now.getTime() + 1000);
    const active = activateProvisionalResource(r, later);
    expect(active.version).toBe(r.version + 1);
    expect(active.updatedAt).toEqual(later);
    expect(active.id).toBe(r.id);
  });

  it("rejects reactivation from quarantined", () => {
    const quarantined = quarantineResource(
      fixtures.provisionalResource(),
      fixtures.now,
    );
    expect(() =>
      activateProvisionalResource(quarantined, fixtures.now),
    ).toThrow(DomainError);
  });

  it("rejects transitions out of deleted", () => {
    const deleted = completeResourceDeletion(
      beginResourceDeletion(
        activateProvisionalResource(
          fixtures.provisionalResource(),
          fixtures.now,
        ),
        fixtures.now,
      ),
      fixtures.now,
    );
    expect(canTransitionResource("deleted", "active")).toBe(false);
    expect(canTransitionResource("deleted", "deleted")).toBe(false);
  });
});

describe("maybeExpireProvisionalResource", () => {
  it("returns non-provisional/non-active resources unchanged even past TTL", () => {
    const quarantined = quarantineResource(
      fixtures.provisionalResource({
        expiresAt: new Date(fixtures.now.getTime() - 1),
      }),
      fixtures.now,
    );
    expect(
      maybeExpireProvisionalResource(quarantined, () => fixtures.now),
    ).toBe(quarantined);
  });

  it("returns provisional resources without an expiresAt unchanged", () => {
    const { expiresAt: _expiresAt, ...r } = fixtures.provisionalResource();
    expect(maybeExpireProvisionalResource(r, () => fixtures.now)).toBe(r);
  });

  it("expires active resources past their TTL", () => {
    const active = activateProvisionalResource(
      fixtures.provisionalResource(),
      fixtures.now,
    );
    const expired = maybeExpireProvisionalResource(
      active,
      () => new Date(fixtures.now.getTime() + 3_600_000 + 1),
    );
    expect(expired.state).toBe("expired");
  });

  it("defaults to the wall clock", () => {
    const r = fixtures.provisionalResource({
      expiresAt: new Date(Date.now() - 1),
    });
    expect(maybeExpireProvisionalResource(r).state).toBe("expired");
  });
});
