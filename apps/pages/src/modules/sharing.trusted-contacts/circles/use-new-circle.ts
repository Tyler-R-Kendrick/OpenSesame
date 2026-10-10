/**
 * The run of steps that makes a circle: what the owner has chosen so far, and
 * what each key does with it (ADR 0186 §10). Everything that matters is in the
 * desk; this keeps the forms, derives what the desk is asked to judge, and
 * moves from one step to the next.
 *
 * Steps are reached in order and an earlier one can be gone back to until the
 * circle is made. A step that has not been reached is not drawn. A circle
 * begun and left is still there when the sheet is opened again; one with no
 * contacts is let go of when the sheet is closed, because nothing is lost.
 */

import {
  type Begun,
  type CustodyStatus,
  type Dealt,
  createFromDraft,
  custodyStatus,
  discardDraft,
  draftForPreview,
  inviteText,
  previewCircle,
  unfinishedCircle,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import type { Guardian } from "@opensesame/app-core/lib/quorum/types.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CeremonyFailure, useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";
import type { Carried } from "./DealtStep.js";
import {
  type ClocksDraft,
  DEFAULT_CLOCKS,
  type Issue,
  type Person,
  type Review,
  type RuleDraft,
  type Scope,
  protectsOf,
} from "./circle-model.js";
import { type PayloadSource, circlePayload } from "./circle-payload.js";
import { type Judge, type Reviewed, useReview } from "./use-review.js";

export type Step = "name" | "people" | "rule" | "clocks" | "dealt";

const ORDER: readonly Step[] = ["name", "people", "rule", "clocks", "dealt"];

/** The steps a person can go back to, in the order they are reached. */
export const RUN: readonly Step[] = ["people", "rule", "clocks"];

/** Whether `step` has been reached by the time `furthest` has. */
export function reached(step: Step, furthest: Step): boolean {
  return ORDER.indexOf(step) <= ORDER.indexOf(furthest);
}

export type Made = Readonly<{
  dealt: Dealt;
  custody: CustodyStatus;
  carried: Carried | null;
}>;

export type NewCircle = Readonly<{
  /** False while a circle left unfinished is being looked for. */
  ready: boolean;
  step: Step;
  /** The furthest step reached; every step up to it can be gone back to. */
  furthest: Step;
  begun: Begun | null;
  guardians: readonly Guardian[];
  people: readonly Person[];
  rule: RuleDraft;
  clocks: ClocksDraft;
  made: Made | null;
  busy: boolean;
  failure: CeremonyFailure;
  ruleIssues: readonly Issue[];
  clockIssues: readonly Issue[];
  review: Review;
  begin(begun: Begun, scope: Scope): void;
  setGuardians(next: readonly Guardian[]): void;
  setRule(next: RuleDraft): void;
  setClocks(next: ClocksDraft): void;
  go(step: Step): void;
  make(): Promise<void>;
  /** Let go of a circle that was begun and has no contacts. */
  leave(): void;
}>;

type Resumed = Readonly<{ begun: Begun; guardians: readonly Guardian[] }>;

/** The circle that was begun and left, as the run would have it. */
async function resumed(desk: Desk): Promise<Resumed | null> {
  const draft = await unfinishedCircle(desk.ports);
  return draft
    ? {
        begun: { draft, invite: inviteText(draft) },
        guardians: draft.guardians,
      }
    : null;
}

/** Look once, when the sheet opens, for a circle left unfinished. */
function useResume(desk: Desk, apply: (found: Resumed) => void): boolean {
  const [ready, setReady] = useState(false);
  const looked = useRef(false);
  useEffect(() => {
    if (looked.current) return;
    looked.current = true;
    resumed(desk)
      .then((found) => {
        if (found) apply(found);
      })
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, [desk, apply]);
  return ready;
}

type MakeInput = Readonly<{
  desk: Desk;
  vault: PayloadSource;
  begun: Begun | null;
  scope: Scope;
  reviewed: Reviewed;
  onMade: (made: Made) => void;
}>;

/** The key that makes the circle: what it protects is read from the vault now, and goes straight to the desk. */
function useMake(input: MakeInput) {
  const { desk, vault, begun, scope, reviewed, onMade } = input;
  const [busy, setBusy] = useState(false);
  const failure = useCeremonyFailure(
    "trusted-contacts:circle-make",
    "Start a circle",
  );
  const { ruleParse, clockParse } = reviewed;
  const make = useCallback(async () => {
    if (busy || !begun || !ruleParse.ok || !clockParse.ok) return;
    setBusy(true);
    const done = await failure.run(async () => {
      const { circleId, recovers } = begun.draft;
      const payload = recovers ? circlePayload(vault, scope) : undefined;
      const dealt = await createFromDraft(desk.ports, circleId, {
        rule: ruleParse.rule,
        timing: clockParse.timing,
        payload: payload?.document,
      });
      await desk.refresh();
      return {
        dealt,
        custody: await custodyStatus(desk.ports, circleId),
        carried: payload
          ? { skipped: payload.skipped, withheld: payload.withheld }
          : null,
      };
    });
    setBusy(false);
    if (done.ok) onMade(done.value);
  }, [busy, begun, ruleParse, clockParse, failure, vault, scope, desk, onMade]);
  return { busy, failure, make };
}

/** What the owner has chosen so far, and the two moves between steps. */
function useRunState() {
  const [step, setStep] = useState<Step>("name");
  const [furthest, setFurthest] = useState<Step>("name");
  const [begun, setBegun] = useState<Begun | null>(null);
  const [scope, setScope] = useState<Scope>({
    protects: "everything",
    folder: "",
  });
  const [guardians, setGuardians] = useState<readonly Guardian[]>([]);
  const [rule, setRule] = useState<RuleDraft | null>(null);
  const [clocks, setClocks] = useState<ClocksDraft>(DEFAULT_CLOCKS);
  const [made, setMade] = useState<Made | null>(null);
  const go = useCallback((next: Step) => {
    setStep(next);
    setFurthest((now) => (reached(next, now) ? now : next));
  }, []);
  const begin = useCallback(
    (started: Begun, chosen: Scope) => {
      setBegun(started);
      setScope(chosen);
      setGuardians([]);
      go("people");
    },
    [go],
  );
  const onMade = useCallback((next: Made) => {
    setMade(next);
    setStep("dealt");
  }, []);
  return {
    step,
    furthest,
    begun,
    setBegun,
    scope,
    setScope,
    guardians,
    setGuardians,
    rule,
    setRule,
    clocks,
    setClocks,
    made,
    onMade,
    go,
    begin,
  };
}

export function useNewCircle(
  desk: Desk,
  vault: PayloadSource,
  onClose: () => void,
): NewCircle {
  const { ports } = desk;
  const run = useRunState();
  const { begun, guardians, made, go } = run;
  const { setBegun, setGuardians, setScope } = run;
  const folderNames = vault.folders.map((folder) => folder.name).join("\n");
  const ready = useResume(
    desk,
    useCallback(
      (found: Resumed) => {
        setBegun(found.begun);
        setGuardians(found.guardians);
        setScope(
          protectsOf(
            found.begun.draft.recovers,
            found.begun.draft.collection,
            folderNames.split("\n"),
          ),
        );
        go("people");
      },
      [go, folderNames, setBegun, setGuardians, setScope],
    ),
  );

  const people = useMemo<Person[]>(
    () => guardians.map((g) => ({ id: g.id, name: g.name })),
    [guardians],
  );
  const judge = useMemo<Judge | null>(
    () =>
      begun && guardians.length > 0
        ? (rule, timing) =>
            previewCircle(
              draftForPreview(
                ports,
                { ...begun.draft, guardians: [...guardians] },
                rule,
                timing,
              ),
            )
        : null,
    [ports, begun, guardians],
  );
  const reviewed = useReview(people, run.rule, run.clocks, judge);
  const { busy, failure, make } = useMake({
    desk,
    vault,
    begun,
    scope: run.scope,
    reviewed,
    onMade: run.onMade,
  });
  const leave = useCallback(() => {
    if (begun && made === null && guardians.length === 0) {
      void discardDraft(ports, begun.draft.circleId).catch(() => undefined);
    }
    onClose();
  }, [begun, made, guardians.length, ports, onClose]);

  return {
    ready,
    step: run.step,
    furthest: run.furthest,
    begun,
    guardians,
    people,
    rule: reviewed.rule,
    clocks: run.clocks,
    made,
    busy,
    failure,
    ruleIssues: reviewed.ruleIssues,
    clockIssues: reviewed.clockIssues,
    review: reviewed.review,
    begin: run.begin,
    setGuardians,
    setRule: run.setRule,
    setClocks: run.setClocks,
    go,
    make,
    leave,
  };
}
