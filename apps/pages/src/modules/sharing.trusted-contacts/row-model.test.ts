import {
  Clock,
  armedCircle,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import { describe, expect, it } from "vitest";
import {
  circleFacts,
  circleMark,
  countText,
  heldFacts,
  heldMark,
  recoveryFacts,
  recoveryMark,
  when,
} from "./row-model.js";

const AT = "2026-10-11T12:00:00.000Z";

describe("countText", () => {
  it("says none, one and many", () => {
    expect(countText(0, "circle")).toBe("No circles");
    expect(countText(1, "circle")).toBe("1 circle");
    expect(countText(3, "contact")).toBe("3 contacts");
    expect(countText(0, "recovery", "recoveries")).toBe("No recoveries");
    expect(countText(2, "recovery", "recoveries")).toBe("2 recoveries");
  });
});

describe("a circle's row", () => {
  it("states the rule, the epoch and the contacts of the policy it holds", async () => {
    const armed = await armedCircle(new Clock());
    const [owned] = await armed.owner.records.owned();
    if (!owned) throw new Error("no circle");
    expect(circleFacts(owned.signedPolicy.policy)).toBe(
      "2 of 3 · epoch 1 · 3 contacts",
    );
  });

  it("says approvals only when the circle protects no secret", async () => {
    const armed = await armedCircle(new Clock(), { recovers: false });
    const [owned] = await armed.owner.records.owned();
    if (!owned) throw new Error("no circle");
    expect(circleFacts(owned.signedPolicy.policy)).toContain("approvals only");
  });

  it("marks every state with a tone and a sentence", () => {
    expect(circleMark("armed").tone).toBe("ok");
    expect(circleMark("inviting").tone).toBe("idle");
    expect(circleMark("recovering").tone).toBe("warn");
    expect(circleMark("retired").tone).toBe("idle");
    for (const state of ["armed", "inviting", "recovering", "retired"] as const)
      expect(circleMark(state).label.length).toBeGreaterThan(5);
  });
});

describe("a held share's row", () => {
  it("names whose circle it is by the owner key's fingerprint, and share or seat", async () => {
    const armed = await armedCircle(new Clock());
    const [held] = (await armed.people.get("Ada")?.records.held()) ?? [];
    if (!held) throw new Error("nothing held");
    const { policy } = held.seat.signedPolicy;
    expect(heldFacts(policy, true)).toMatch(
      /^Held for [0-9a-f]{4}(-[0-9a-f]{4}){3} · share · epoch 1$/,
    );
    expect(heldFacts(policy, false)).toContain(" · seat · ");
  });

  it("marks every state", () => {
    expect(heldMark("held")).toEqual({ tone: "ok", label: "Held" });
    expect(heldMark("approved").tone).toBe("warn");
    expect(heldMark("released").tone).toBe("idle");
    expect(heldMark("retired").tone).toBe("idle");
  });
});

describe("a recovery's row", () => {
  it("counts approvals and releases", () => {
    expect(recoveryFacts(["a", "b"], ["a"])).toBe("2 approved · 1 released");
  });

  it("marks every ledger state, with the time where there is one", () => {
    const at = when(AT);
    expect(
      recoveryMark({ state: "collecting", approved: 1, closesAt: AT }),
    ).toEqual({
      tone: "idle",
      label: `Collecting approvals until ${at}`,
    });
    expect(
      recoveryMark({ state: "waiting", releasableAt: AT }).label,
    ).toContain(at);
    expect(recoveryMark({ state: "releasable", until: AT })).toMatchObject({
      tone: "ok",
    });
    expect(recoveryMark({ state: "authorized", until: AT }).label).toContain(
      at,
    );
    expect(recoveryMark({ state: "approval_closed" }).tone).toBe("warn");
    for (const state of ["complete", "executed"] as const)
      expect(recoveryMark({ state }).tone).toBe("ok");
    for (const state of ["cancelled", "expired"] as const)
      expect(recoveryMark({ state }).tone).toBe("err");
  });
});
