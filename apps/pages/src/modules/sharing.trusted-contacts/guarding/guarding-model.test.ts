import type {
  InviteView,
  Phase,
  RequestView,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { describe, expect, it } from "vitest";
import {
  inviteFacts,
  mayRelease,
  noticeMark,
  originMark,
  phaseMark,
  requestFacts,
  takenMark,
} from "./guarding-model.js";

const PHASES: readonly [Phase, string, string][] = [
  ["approve", "ok", "Open for approval"],
  ["wait", "idle", "Waiting for the delay"],
  ["release", "ok", "Ready to release"],
  ["over", "idle", "Closed"],
  ["cancelled", "idle", "Cancelled by the owner"],
];

function request(overrides: Partial<RequestView> = {}): RequestView {
  return {
    circleLabel: "Family",
    operation: "recover-collection",
    summary: "Release the recovery key",
    recipientLabel: "New laptop",
    recipientFingerprint: "aaaa-bbbb-cccc-dddd",
    approveBy: "2026-10-11T12:00:00.000Z",
    releasableAt: "2026-10-11T13:00:00.000Z",
    expiresAt: "2026-10-17T12:00:00.000Z",
    phase: "approve",
    digest: "sha256:x",
    canRelease: true,
    ...overrides,
  };
}

function invite(origins: string[]): InviteView {
  return {
    invite: {
      v: 1,
      kind: "invite",
      inviteId: "i",
      circleId: "c-1",
      label: "Family",
      rpId: "vault.example.test",
      origins,
      ownerKey: "k",
      requireUserVerification: true,
      createdAt: "2026-10-10T12:00:00.000Z",
      expiresAt: "2026-10-17T12:00:00.000Z",
    },
    ownerFingerprint: "1111-2222-3333-4444",
    originOk: false,
  };
}

describe("where a request stands", () => {
  it.each(PHASES)("says %s as a %s mark: %s", (phase, tone, label) => {
    expect(phaseMark(phase)).toEqual({ tone, label });
  });

  it("offers a release only to a device that holds a share, once the delay has passed", () => {
    expect(mayRelease(request({ phase: "release", canRelease: true }))).toBe(
      true,
    );
    expect(mayRelease(request({ phase: "release", canRelease: false }))).toBe(
      false,
    );
    for (const phase of ["approve", "wait", "over", "cancelled"] as const) {
      expect(mayRelease(request({ phase, canRelease: true }))).toBe(false);
    }
  });

  it("lists the facts a guardian checks, the recipient's key by its short name", () => {
    expect(requestFacts(request()).map((fact) => fact.key)).toEqual([
      "Circle",
      "Operation",
      "For",
      "Recipient key",
      "Approve by",
      "Releases from",
      "Expires",
    ]);
    expect(
      requestFacts(request()).find((fact) => fact.key === "Recipient key")
        ?.value,
    ).toBe("aaaa-bbbb-cccc-dddd");
  });
});

describe("what an invitation says", () => {
  it("states the owner's key by its short name and every origin it opens at", () => {
    const view = invite(["https://a.example.test", "https://b.example.test"]);
    const facts = inviteFacts(view);
    expect(facts.map((fact) => fact.key)).toEqual([
      "Owner key",
      "Origins",
      "Expires",
    ]);
    expect(facts[0]?.value).toBe("1111-2222-3333-4444");
    expect(facts[1]?.value).toBe(
      "https://a.example.test, https://b.example.test",
    );
  });

  it("names the first origin to open it at", () => {
    expect(originMark(invite(["https://a.example.test"]))).toEqual({
      tone: "err",
      label: "Open this invitation at https://a.example.test",
    });
  });
});

describe("what taking something did", () => {
  it("tells a share from a seat by whether there is a receipt to hand back", () => {
    const base = { circleLabel: "Family", epoch: 1 };
    expect(takenMark({ ...base, receipt: "osq1.receipt.x.000000" })).toEqual({
      tone: "ok",
      label: "Share taken",
    });
    expect(takenMark({ ...base, receipt: null })).toEqual({
      tone: "ok",
      label: "Seat taken",
    });
  });

  it("words each outcome of a policy that arrived by itself, of that circle", () => {
    expect(noticeMark("Family", "retired")).toEqual({
      tone: "idle",
      label: "You are no longer in Family",
    });
    expect(noticeMark("Family", "awaiting_share")).toEqual({
      tone: "warn",
      label: "Waiting for your new share in Family",
    });
    expect(noticeMark("Family", "adopted")).toEqual({
      tone: "ok",
      label: "Family is up to date",
    });
  });
});
