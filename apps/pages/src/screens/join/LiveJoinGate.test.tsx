/** @vitest-environment jsdom */
/**
 * The live-join gate's two failures, each in the notifications tray under its
 * own id and on the page as a mark: an installation that refuses Live
 * sessions, and a commit that did not land.
 */
import type { CompositionSnapshot } from "@opensesame/app-core/lib/capabilities/store-types.js";
import { double } from "@opensesame/app-core/lib/configuration/doubles/test-support.js";
import { dismissNotice } from "@opensesame/app-core/lib/notices.js";
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectInTray, inTray } from "../../components/tray.test-support.js";
import { LiveJoinGate, liveJoinGateSeams } from "./LiveJoinGate.js";

type LiveState = {
  approved: boolean;
  distributed: boolean;
  permitted: boolean;
};

const REVIEWED = {
  schemaVersion: 1,
  kind: "InstallationCapabilitySelection",
  instanceId: "acme",
  installationId: "inst-1",
  basePolicyRevision: "0",
  revision: "1",
  acceptedRequired: [],
  selectedOptional: [],
  chosenAlternatives: {},
  delivery: { prefetch: "none", offlineCache: "shell-only" },
} satisfies Parameters<typeof double.review>[0];

let snapshot: CompositionSnapshot = double.getSnapshot();
let commit: string | null = null;

const originalSeams = { ...liveJoinGateSeams };
Object.assign(liveJoinGateSeams, {
  useComposition: () => snapshot,
  useSupportRoute: () => {},
  proposalFor: () => ({ roots: [], alternatives: {} }),
  reviewFor: () => double.review(REVIEWED),
  commitProposal: async () => commit,
  Review: ({ onApply }: { onApply: () => void }) => (
    <button type="button" onClick={onApply}>
      Apply
    </button>
  ),
});
afterAll(() => Object.assign(liveJoinGateSeams, originalSeams));

const NOT_ALLOWED = "Live sessions are not allowed on this installation";

/** The store's snapshot with no plan yet: the gate is still opening. */
function opening(): CompositionSnapshot {
  return { ...double.getSnapshot(), plan: null, selection: null };
}

/** A ready snapshot whose plan holds Live sessions in the state given. */
function ready(live: LiveState): CompositionSnapshot {
  return {
    ...opening(),
    plan: overlapCast({ capabilities: { "sharing.live": live } }),
  };
}

function mount() {
  return render(
    <MemoryRouter>
      <LiveJoinGate link={null} onClose={() => {}} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  snapshot = opening();
  commit = null;
});
afterEach(() => {
  cleanup();
  dismissNotice("join:live-not-allowed");
  dismissNotice("join:live-commit");
});

describe("LiveJoinGate failures", () => {
  it("marks and trays an installation that does not allow Live sessions", async () => {
    snapshot = ready({
      approved: false,
      distributed: false,
      permitted: false,
    });
    mount();
    screen.getByRole("img", { name: NOT_ALLOWED });
    await expectInTray(NOT_ALLOWED);
  });

  it("raises nothing while the plan is still opening", () => {
    mount();
    screen.getByRole("img", { name: "Opening…" });
    expect(inTray("Live sessions")).toBe(false);
  });

  it("marks and trays a commit that did not land, apart from the refusal", async () => {
    snapshot = ready({
      approved: false,
      distributed: true,
      permitted: true,
    });
    commit = "refused · policy withdrew it";
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByRole("img", { name: "refused · policy withdrew it" });
    await expectInTray("refused · policy withdrew it");
    expect(inTray(NOT_ALLOWED)).toBe(false);
  });
});
