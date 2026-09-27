import { describe, expect, it } from "vitest";
import type { LocalAccessAuditEvent } from "./local-access-audit.js";
import { standingConnectionRevoked } from "./standing-connection-grants.js";

/** The two trail fields the rule reads; an event may carry either, both, or none. */
type TrailFields = { subject?: string; policy?: string };

let seq = 0;
function event(
  eventType: "access.connection.granted" | "access.connection.revoked",
  targetId: string,
  metadata: TrailFields = {},
): LocalAccessAuditEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    occurredAt: new Date(seq * 1000).toISOString(),
    eventType,
    outcome: "succeeded",
    correlationId: `corr-${seq}`,
    targetType: "connection",
    targetId,
    metadata,
  };
}

const agentUse = { resourceId: "github", principalId: "agent", policy: "use" };

describe("standingConnectionRevoked", () => {
  it("is false with no grant or revoke on the trail", () => {
    expect(standingConnectionRevoked([], agentUse)).toBe(false);
  });

  it("holds a revocation for its own connector, principal and policy only", () => {
    const trail = [
      event("access.connection.revoked", "github", {
        subject: "agent",
        policy: "use",
      }),
    ];
    expect(standingConnectionRevoked(trail, agentUse)).toBe(true);
    expect(
      standingConnectionRevoked(trail, { ...agentUse, principalId: "owner" }),
    ).toBe(false);
    expect(
      standingConnectionRevoked(trail, { ...agentUse, policy: "invoke" }),
    ).toBe(false);
    expect(
      standingConnectionRevoked(trail, { ...agentUse, resourceId: "slack" }),
    ).toBe(false);
  });

  it("lets a newer grant for the principal supersede an older revocation", () => {
    // Newest first, as listAccessAuditEvents returns the trail.
    const trail = [
      event("access.connection.granted", "github", {
        subject: "agent",
        policy: "use",
      }),
      event("access.connection.revoked", "github", {
        subject: "agent",
        policy: "use",
      }),
    ];
    expect(standingConnectionRevoked(trail, agentUse)).toBe(false);
  });

  it("ignores an event that names no principal, as it was read when written", () => {
    const trail = [event("access.connection.revoked", "github")];
    expect(standingConnectionRevoked(trail, agentUse)).toBe(false);
  });

  it("counts an event that names a principal but no policy for every policy", () => {
    const trail = [
      event("access.connection.revoked", "github", { subject: "agent" }),
    ];
    expect(standingConnectionRevoked(trail, agentUse)).toBe(true);
    expect(
      standingConnectionRevoked(trail, { ...agentUse, policy: "invoke" }),
    ).toBe(true);
  });
});
