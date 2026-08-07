import { describe, expect, it } from "vitest";
import {
  activateProvisionalResource,
  beginResourceDeletion,
  completeResourceDeletion,
  DomainError,
  expireProvisionalResource,
  maybeExpireProvisionalResource,
  quarantineResource,
} from "../index.js";
import { fixtures } from "./fixtures.js";

describe("provisional resource state machine", () => {
  it("allows provisional→active", () => {
    const r = fixtures.provisionalResource();
    expect(activateProvisionalResource(r, fixtures.now).state).toBe("active");
  });

  it("allows provisional→expired→deleting→deleted", () => {
    let r = fixtures.provisionalResource();
    r = expireProvisionalResource(r, fixtures.now);
    expect(r.state).toBe("expired");
    r = beginResourceDeletion(r, fixtures.now);
    expect(r.state).toBe("deleting");
    r = completeResourceDeletion(r, fixtures.now);
    expect(r.state).toBe("deleted");
  });

  it("allows quarantine from provisional", () => {
    expect(
      quarantineResource(fixtures.provisionalResource(), fixtures.now).state,
    ).toBe("quarantined");
  });

  it("rejects invalid transitions", () => {
    const deleted = completeResourceDeletion(
      beginResourceDeletion(
        expireProvisionalResource(fixtures.provisionalResource(), fixtures.now),
        fixtures.now,
      ),
      fixtures.now,
    );
    expect(() => activateProvisionalResource(deleted, fixtures.now)).toThrow(
      DomainError,
    );
  });

  it("auto-expires via injected clock", () => {
    const r = fixtures.provisionalResource({
      expiresAt: new Date(fixtures.now.getTime() + 1000),
    });
    const still = maybeExpireProvisionalResource(r, () => fixtures.now);
    expect(still.state).toBe("provisional");
    const expired = maybeExpireProvisionalResource(
      r,
      () => new Date(fixtures.now.getTime() + 2000),
    );
    expect(expired.state).toBe("expired");
  });
});
