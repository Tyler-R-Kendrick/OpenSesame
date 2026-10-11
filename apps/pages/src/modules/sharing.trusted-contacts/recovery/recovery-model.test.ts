import type {
  Progress,
  RecoveryView,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { LedgerStatus } from "@opensesame/app-core/lib/quorum/ledger-types.js";
import { decodePacket } from "@opensesame/app-core/lib/quorum/packets.js";
import { describe, expect, it } from "vitest";
import { when } from "../row-model.js";
import {
  askAgainWho,
  canOpen,
  describeAnswer,
  documentText,
  namesOf,
  panelSaid,
  recoveredFileName,
  statusFact,
  wantsApprovals,
} from "./recovery-model.js";
import {
  approvalOf,
  approvedBy,
  recovering,
  releaseOf,
} from "./recovery.test-support.js";

const NAMES = { ada: "Ada", ben: "Ben", cy: "Cy" };

/** A 2-of-3 circle's recovery with `approvedBy` and `releasedBy` counted against the rule. */
function viewAt(
  status: LedgerStatus,
  approvedBy: readonly string[] = [],
  releasedBy: readonly string[] = [],
  progress: Partial<RecoveryView["progress"]> = {},
): RecoveryView {
  const against = (ids: readonly string[]): Progress => ({
    have: Math.min(ids.length, 2),
    need: 2,
    unit: "contacts",
  });
  return {
    requestId: "r1",
    label: "Family",
    request: "osq1.request.x.000000",
    status,
    approvedBy,
    releasedBy,
    names: NAMES,
    progress: {
      approvals: against(approvedBy),
      releases: against(releasedBy),
      ...progress,
    },
  };
}

const LATER = "2026-10-12T15:20:00.000Z";

describe("the one line a sheet states", () => {
  it("counts approvals against what the rule asks for while they are collected, and after they closed short", () => {
    expect(
      statusFact(
        viewAt({ state: "collecting", approved: 1, closesAt: LATER }, ["ada"]),
      ),
    ).toBe("1 of 2 approved");
    expect(statusFact(viewAt({ state: "approval_closed" }, ["ada"]))).toBe(
      "1 of 2 approved",
    );
  });

  it("says when the delay ends while it is running", () => {
    expect(
      statusFact(
        viewAt({ state: "waiting", releasableAt: LATER }, ["ada", "ben"]),
      ),
    ).toBe(`Waits until ${when(LATER)}`);
  });

  it("counts shares released against what the rule asks for once releases are open, and when there are enough", () => {
    const releasable = viewAt(
      { state: "releasable", until: LATER },
      ["ada", "ben"],
      ["ada"],
    );
    expect(statusFact(releasable)).toBe("1 of 2 shares released");
    expect(
      statusFact(viewAt({ state: "complete" }, ["ada", "ben"], ["ada", "ben"])),
    ).toBe("2 of 2 shares released");
  });

  it("falls back to the approvals for a recovery that was cancelled or ran out", () => {
    expect(statusFact(viewAt({ state: "cancelled" }, ["ada"]))).toBe(
      "1 of 2 approved",
    );
    expect(statusFact(viewAt({ state: "expired" }, []))).toBe(
      "0 of 2 approved",
    );
  });

  it("counts groups, the shortest true thing, when the rule asks for groups to agree", () => {
    const groups = (have: number, need: number): Progress => ({
      have,
      need,
      unit: "groups",
    });
    const collecting = {
      state: "collecting",
      approved: 3,
      closesAt: LATER,
    } as const;
    expect(
      statusFact(
        viewAt(collecting, ["ada", "ben", "cy"], [], {
          approvals: groups(1, 2),
        }),
      ),
    ).toBe("1 of 2 groups approved");
    expect(
      statusFact(
        viewAt({ state: "releasable", until: LATER }, [], [], {
          releases: groups(1, 2),
        }),
      ),
    ).toBe("1 of 2 groups released");
    // One group is one group.
    expect(
      statusFact(viewAt(collecting, [], [], { approvals: groups(0, 1) })),
    ).toBe("0 of 1 group approved");
  });
});

describe("what can be done in each state", () => {
  it("opens only when enough shares are in", () => {
    const states: LedgerStatus[] = [
      { state: "collecting", approved: 0, closesAt: LATER },
      { state: "approval_closed" },
      { state: "waiting", releasableAt: LATER },
      { state: "releasable", until: LATER },
      { state: "cancelled" },
      { state: "expired" },
    ];
    for (const status of states) expect(canOpen(viewAt(status))).toBe(false);
    expect(canOpen(viewAt({ state: "complete" }))).toBe(true);
  });

  it("hands the contacts the approvals only while they are what a release needs", () => {
    expect(
      wantsApprovals(viewAt({ state: "waiting", releasableAt: LATER })),
    ).toBe(true);
    expect(wantsApprovals(viewAt({ state: "releasable", until: LATER }))).toBe(
      true,
    );
    expect(
      wantsApprovals(
        viewAt({ state: "collecting", approved: 1, closesAt: LATER }),
      ),
    ).toBe(false);
    expect(wantsApprovals(viewAt({ state: "complete" }))).toBe(false);
    expect(wantsApprovals(viewAt({ state: "expired" }))).toBe(false);
  });
});

describe("names", () => {
  const view = viewAt({ state: "complete" });

  it("names a contact by the policy's label and leaves out an id it does not list", () => {
    expect(namesOf(view, ["ben", "nobody", "ada"])).toEqual(["Ben", "Ada"]);
    expect(namesOf(view, [])).toEqual([]);
  });

  it("asks again by name, and by 'a contact' for an id the policy does not list", () => {
    expect(askAgainWho(view, ["cy", "stranger"])).toEqual([
      { id: "cy", name: "Cy" },
      { id: "stranger", name: "a contact" },
    ]);
  });

  it("tells a screen reader how many recoveries and how many recovered, in one line", () => {
    expect(panelSaid(0, 0)).toBe("No recoveries");
    expect(panelSaid(1, 0)).toBe("1 recovery");
    expect(panelSaid(2, 1)).toBe("2 recoveries, 1 recovered");
  });
});

describe("what a valid paste is said to be", () => {
  it("names the kind and who it is from, from the policy's own names", async () => {
    const env = await recovering();
    const names = ["Ada", "Ben", "Cy"];
    const view: RecoveryView = {
      ...env.started,
      names: Object.fromEntries(
        env.armed.guardianIds.map((id, at) => [id, names[at] ?? "?"]),
      ),
    };
    const say = describeAnswer(view);
    expect(say(decodePacket(await approvalOf(env, "Ada")))).toBe(
      "An approval from Ada",
    );
    const approvals = await approvedBy(env, ["Ada", "Cy"]);
    expect(say(decodePacket(approvals))).toBe("2 approvals from Ada, Cy");
    expect(say(decodePacket(await releaseOf(env, "Cy", approvals)))).toBe(
      "A release from Cy",
    );
    // Anything that is not an answer is left for the field to refuse.
    expect(say(decodePacket(env.started.request))).toBeNull();
  });

  it("names no one for an id the policy does not list", async () => {
    const env = await recovering();
    const approval = decodePacket(await approvalOf(env, "Ada"));
    expect(describeAnswer({ ...env.started, names: {} })(approval)).toBe(
      "An approval",
    );
  });
});

describe("the recovered document", () => {
  it("is the text of a file, indented and ended with a newline", () => {
    expect(documentText({ items: [{ id: "a" }] })).toBe(
      '{\n  "items": [\n    {\n      "id": "a"\n    }\n  ]\n}\n',
    );
  });

  it("is saved as recovered-<circle>.json", () => {
    expect(recoveredFileName("Family")).toBe("recovered-Family.json");
  });
});
