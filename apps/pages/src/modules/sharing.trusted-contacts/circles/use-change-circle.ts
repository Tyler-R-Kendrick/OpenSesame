/**
 * Changing a circle is making its next epoch (ADR 0186 §9): some contacts
 * leave, the people invited since join, the rule and the clocks are set over
 * who is left, and everyone who stays or joins is dealt a new share. This is
 * the form for it: what is chosen, what the desk is asked to judge, and the
 * one key that signs the new policy.
 */

import {
  type CustodyStatus,
  type Dealt,
  type OwnedRecord,
  circleDraftOf,
  custodyStatus,
  dropDraftGuardian,
  previewCircle,
  readDraft,
  reissue,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type {
  CirclePolicy,
  Guardian,
} from "@opensesame/app-core/lib/quorum/types.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CeremonyFailure, useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";
import type { Carried } from "./DealtStep.js";
import {
  type ClocksDraft,
  type Issue,
  type Person,
  type Review,
  type RuleDraft,
  clocksOf,
  protectsOf,
  ruleFromPolicy,
} from "./circle-model.js";
import { type PayloadSource, circlePayload } from "./circle-payload.js";
import { type Judge, type Reviewed, useReview } from "./use-review.js";

export type Changed = Readonly<{
  dealt: Dealt;
  custody: CustodyStatus;
  carried: Carried | null;
}>;

export type ChangeCircle = Readonly<{
  /** The circle as it stood when the sheet opened. */
  before: CirclePolicy;
  /** False until the people invited since have been looked for. */
  ready: boolean;
  /** Who is in the circle now, and who is leaving. */
  staying: readonly Guardian[];
  leaving: ReadonlySet<string>;
  /** The people invited since, who join at this epoch. */
  newcomers: readonly Guardian[];
  people: readonly Person[];
  rule: RuleDraft;
  clocks: ClocksDraft;
  changed: Changed | null;
  busy: boolean;
  failure: CeremonyFailure;
  removal: CeremonyFailure;
  ruleIssues: readonly Issue[];
  clockIssues: readonly Issue[];
  review: Review;
  toggle(guardianId: string): void;
  dropNewcomer(guardianId: string): Promise<void>;
  setRule(next: RuleDraft): void;
  setClocks(next: ClocksDraft): void;
  make(): Promise<void>;
}>;

/** The people invited since the circle was last changed, and the means to let one go. */
function useNewcomers(desk: Desk, circleId: string) {
  const { ports } = desk;
  const [ready, setReady] = useState(false);
  const [newcomers, setNewcomers] = useState<readonly Guardian[]>([]);
  const removal = useCeremonyFailure(
    "trusted-contacts:contact-remove",
    "Remove a contact",
  );
  const looked = useRef(false);
  useEffect(() => {
    if (looked.current) return;
    looked.current = true;
    readDraft(ports, circleId)
      .then((draft) => setNewcomers(draft?.guardians ?? []))
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, [ports, circleId]);
  const drop = useCallback(
    async (guardianId: string) => {
      await removal.run(async () => {
        await dropDraftGuardian(ports, circleId, guardianId);
        const draft = await readDraft(ports, circleId);
        setNewcomers(draft?.guardians ?? []);
      });
    },
    [ports, circleId, removal],
  );
  return { ready, newcomers, removal, drop };
}

type ReissueInput = Readonly<{
  desk: Desk;
  vault: PayloadSource;
  before: CirclePolicy;
  leaving: ReadonlySet<string>;
  reviewed: Reviewed;
  roster: number;
  onChanged: (changed: Changed) => void;
}>;

/** The key that signs the next epoch: what the circle protects is read from the vault now. */
function useReissue(input: ReissueInput) {
  const { desk, vault, before, leaving, reviewed, roster, onChanged } = input;
  const [busy, setBusy] = useState(false);
  const failure = useCeremonyFailure(
    "trusted-contacts:circle-change",
    "Change the circle",
  );
  const { ruleParse, clockParse } = reviewed;
  const make = useCallback(async () => {
    if (busy || !ruleParse.ok || !clockParse.ok || roster === 0) return;
    setBusy(true);
    const done = await failure.run(async () => {
      const recovers = before.operations.includes("recover-collection");
      const payload = recovers
        ? circlePayload(
            vault,
            protectsOf(
              recovers,
              before.collection,
              vault.folders.map((f) => f.name),
            ),
          )
        : undefined;
      const dealt = await reissue(desk.ports, before.circleId, {
        drop: [...leaving],
        rule: ruleParse.rule,
        timing: clockParse.timing,
        payload: payload?.document,
      });
      await desk.refresh();
      return {
        dealt,
        custody: await custodyStatus(desk.ports, before.circleId),
        carried: payload
          ? { skipped: payload.skipped, withheld: payload.withheld }
          : null,
      };
    });
    setBusy(false);
    if (done.ok) onChanged(done.value);
  }, [
    busy,
    ruleParse,
    clockParse,
    roster,
    failure,
    before,
    vault,
    leaving,
    desk,
    onChanged,
  ]);
  return { busy, failure, make };
}

export function useChangeCircle(
  desk: Desk,
  record: OwnedRecord,
  vault: PayloadSource,
): ChangeCircle {
  const [before] = useState(record.signedPolicy.policy);
  const { newcomers, ready, removal, drop } = useNewcomers(
    desk,
    before.circleId,
  );
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [rule, setRule] = useState<RuleDraft | null>(null);
  const [clocks, setClocks] = useState<ClocksDraft>(() =>
    clocksOf({
      approvalWindowSec: before.approvalWindowSec,
      releaseDelaySec: before.releaseDelaySec,
      requestLifetimeSec: before.requestLifetimeSec,
      requireUserVerification: before.requireUserVerification,
    }),
  );
  const [changed, setChanged] = useState<Changed | null>(null);

  const staying = useMemo(
    () => before.guardians.filter((g) => !leaving.has(g.id)),
    [before, leaving],
  );
  const roster = useMemo(
    () => [...staying, ...newcomers],
    [staying, newcomers],
  );
  const people = useMemo<Person[]>(
    () => roster.map((g) => ({ id: g.id, name: g.name })),
    [roster],
  );
  const judge = useMemo<Judge | null>(
    () =>
      roster.length === 0
        ? null
        : (ruleIn, timing) =>
            previewCircle(
              circleDraftOf(
                before,
                before.operations.includes("recover-collection"),
                roster,
                ruleIn,
                timing,
              ),
            ),
    [before, roster],
  );
  const fresh = useCallback(
    (now: readonly Person[]) => ruleFromPolicy(before, now),
    [before],
  );
  const reviewed = useReview(people, rule, clocks, judge, fresh);
  const { busy, failure, make } = useReissue({
    desk,
    vault,
    before,
    leaving,
    reviewed,
    roster: roster.length,
    onChanged: setChanged,
  });
  const toggle = useCallback((guardianId: string) => {
    setLeaving((now) => {
      const next = new Set(now);
      if (!next.delete(guardianId)) next.add(guardianId);
      return next;
    });
  }, []);

  return {
    before,
    ready,
    staying,
    leaving,
    newcomers,
    people,
    rule: reviewed.rule,
    clocks,
    changed,
    busy,
    failure,
    removal,
    ruleIssues: reviewed.ruleIssues,
    clockIssues: reviewed.clockIssues,
    review: reviewed.review,
    toggle,
    dropNewcomer: drop,
    setRule,
    setClocks,
    make,
  };
}
