import { describe, expect, it } from "vitest";
import { type PresentationSession, transitionPresentation } from "../index.js";

const session = (state: PresentationSession["state"]): PresentationSession => ({
  id: "presentation",
  protocol: "internal",
  verifierId: "rp",
  requestObjectDigest: "digest",
  nonceDigest: new Uint8Array([1]),
  requestedClaims: ["verified_email"],
  purpose: "booking",
  assuranceRequirement: { subjectKind: "human" },
  state,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: new Date("2026-01-02T00:00:00Z"),
  version: 1,
});

describe("presentation state machine", () => {
  it("rejects reopening a terminal state", () => {
    expect(() =>
      transitionPresentation(
        session("completed"),
        "created",
        new Date("2026-01-01T01:00:00Z"),
      ),
    ).toThrow(/invalid presentation transition/);
  });
  it("records activation and completion timestamps", () => {
    const activated = transitionPresentation(
      session("activation_required"),
      "activated",
      new Date("2026-01-01T01:00:00Z"),
    );
    expect(activated.activatedAt?.toISOString()).toBe(
      "2026-01-01T01:00:00.000Z",
    );
  });
});
