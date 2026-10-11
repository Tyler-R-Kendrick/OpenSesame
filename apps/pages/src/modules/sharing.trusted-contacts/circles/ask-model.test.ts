import {
  Clock,
  armedCircle,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  type AskView,
  askToShare,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { LedgerStatus } from "@opensesame/app-core/lib/quorum/ledger-types.js";
import { createItem } from "@opensesame/vault-core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DURATIONS,
  askFact,
  askMark,
  askName,
  grantOf,
  policiesFor,
  targetsOf,
} from "./ask-model.js";
import { BANK_FOLDER, someItems } from "./circles.test-support.js";

const AT = "2026-10-11T12:00:00.000Z";

describe("where a request stands", () => {
  const cases: readonly (readonly [LedgerStatus, string, string])[] = [
    [
      { state: "collecting", approved: 1, closesAt: AT },
      "idle",
      "Collecting approvals until ",
    ],
    [
      { state: "approval_closed" },
      "warn",
      "Approvals closed before enough came in",
    ],
    [{ state: "waiting", releasableAt: AT }, "idle", "Waits until "],
    [{ state: "authorized", until: AT }, "ok", "Approved until "],
    [{ state: "executed" }, "ok", "Shared"],
    [{ state: "cancelled" }, "err", "Cancelled by the owner"],
    [{ state: "expired" }, "err", "Expired"],
    [{ state: "releasable", until: AT }, "idle", "Under way"],
    [{ state: "complete" }, "idle", "Under way"],
  ];
  it.each(cases)("%j is a %s mark", (status, tone, label) => {
    const mark = askMark(status);
    expect(mark.tone).toBe(tone);
    expect(mark.label.startsWith(label)).toBe(true);
  });

  let real: AskView;
  beforeAll(async () => {
    const armed = await armedCircle(new Clock(), { recovers: false });
    real = await askToShare(armed.owner, armed.circleId, {
      principalId: "local_x",
      resourceKind: "item",
      resourceId: "i",
      resourceLabel: "Bank login",
      policy: "read",
      durationSeconds: 3600,
    });
  });

  const view = (status: LedgerStatus, approved: number): AskView => ({
    ...real,
    status,
    approvedBy: Array.from({ length: approved }, (_, i) => `g${i}`),
  });

  it("is told in words a person says: how many, and when a wait ends", () => {
    expect(askFact(view({ state: "executed" }, 2), 3)).toBe("2 of 3 approved");
    expect(askFact(view({ state: "waiting", releasableAt: AT }, 2), 3)).toMatch(
      /^2 of 3 approved · waits until /,
    );
    expect(askName(view({ state: "executed" }, 0))).toBe("Bank login · read");
  });
});

describe("what a circle can be asked to share", () => {
  it("is the vault's live, named items and folders, as the share ledger names them", () => {
    const gone = { ...createItem("secret", "Old"), deletedAt: AT };
    const nameless = createItem("secret", "  ");
    const items = [...someItems(), gone, nameless];
    expect(
      targetsOf({ items, folders: [BANK_FOLDER] }, "item").map((t) => t.label),
    ).toEqual(["Router", "Banking / Savings"]);
    expect(
      targetsOf(
        {
          items,
          folders: [BANK_FOLDER, { ...BANK_FOLDER, id: "x", name: " " }],
        },
        "folder",
      ),
    ).toEqual([{ id: BANK_FOLDER.id, label: "Banking" }]);
  });

  it("offers the policies and durations the ledger allows, and builds its grant", () => {
    expect(policiesFor("item").map((p) => p.value)).toEqual(["read", "use"]);
    expect(policiesFor("folder").map((p) => p.value)).toEqual(["read", "use"]);
    expect(DURATIONS.map((d) => d.value)).toEqual([3600, 28800, 86400, 604800]);
    expect(
      grantOf({
        principalId: "local_x",
        kind: "folder",
        target: { id: "f", label: "Banking" },
        policy: "use",
        durationSeconds: 86400,
      }),
    ).toEqual({
      principalId: "local_x",
      resourceKind: "folder",
      resourceId: "f",
      resourceLabel: "Banking",
      policy: "use",
      durationSeconds: 86400,
    });
  });
});
