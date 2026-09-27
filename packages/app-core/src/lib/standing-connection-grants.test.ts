import { describe, expect, it } from "vitest";
import type { LocalAccessAuditEvent } from "./local-access-audit.js";
import { standingConnectionRevoked } from "./standing-connection-grants.js";

let seq = 0;
function event(
  eventType: "access.connection.granted" | "access.connection.revoked",
  targetId: string,
  subject?: string,
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
    metadata: subject === undefined ? {} : { subject },
  };
}

describe("standingConnectionRevoked", () => {
  it("is false with no grant or revoke on the trail", () => {
    expect(standingConnectionRevoked([], "github", "owner")).toBe(false);
  });

  it("holds a revocation for its own principal only", () => {
    const trail = [event("access.connection.revoked", "github", "agent")];
    expect(standingConnectionRevoked(trail, "github", "agent")).toBe(true);
    expect(standingConnectionRevoked(trail, "github", "owner")).toBe(false);
    expect(standingConnectionRevoked(trail, "slack", "agent")).toBe(false);
  });

  it("lets a newer grant for the principal supersede an older revocation", () => {
    // Newest first, as listAccessAuditEvents returns the trail.
    const trail = [
      event("access.connection.granted", "github", "owner"),
      event("access.connection.revoked", "github", "owner"),
    ];
    expect(standingConnectionRevoked(trail, "github", "owner")).toBe(false);
  });

  it("reads a revocation that names no principal as covering every principal", () => {
    const trail = [event("access.connection.revoked", "github")];
    expect(standingConnectionRevoked(trail, "github", "owner")).toBe(true);
    expect(standingConnectionRevoked(trail, "github", "agent")).toBe(true);
  });
});
