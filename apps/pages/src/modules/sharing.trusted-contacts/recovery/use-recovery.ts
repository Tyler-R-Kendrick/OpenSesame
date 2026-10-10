/**
 * One recovery's sheet, as state over the desk (ADR 0186 §10): where it
 * stands, what each pasted answer did, and the two steps that end it — open
 * it, or give it up.
 *
 * Every step is a desk function; these hooks keep what the sheet shows
 * between them. The recipient's key and the recovered document never pass
 * through here as anything but the text `onOpened` is handed.
 */

import {
  type DeskPorts,
  type RecoveryView,
  abandonRecovery,
  approvalsPacket,
  ingest,
  openRecovery,
  recoveryStatus,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { RecoveryError } from "@opensesame/app-core/lib/quorum/index.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFailureNotice } from "../../../components/use-failure-notice.js";
import { sentence, useCeremonyFailure } from "../failure-text.js";
import type { Desk } from "../use-desk.js";
import {
  type Contact,
  askAgainWho,
  documentText,
  wantsApprovals,
} from "./recovery-model.js";
import type { Recovered } from "./use-recovered.js";

export type RecoveryRunInput = Readonly<{
  desk: Desk;
  initial: RecoveryView;
  /** The list behind the sheet is read again. */
  onChanged: () => Promise<void>;
  /** The recovery is open: its document is handed on, once, and the sheet is done. */
  onOpened: (item: Omit<Recovered, "safe">) => Promise<void>;
  onGaveUp: () => Promise<void>;
}>;

export type RecoveryRun = Readonly<{
  view: RecoveryView;
  /** The approvals so far as a packet, once contacts need them to release. */
  approvals: string | null;
  /** The sentence for each answer in the last paste that was refused. */
  refused: readonly string[];
  /** Whom to ask to release again, after a release that did not open. */
  askAgain: readonly Contact[];
  checkFailure: string;
  openFailure: string;
  giveUpFailure: string;
  opening: boolean;
  giving: boolean;
  add: (text: string) => Promise<void>;
  check: () => Promise<void>;
  open: () => Promise<void>;
  giveUp: () => Promise<void>;
}>;

/** The value as of the last render, for a step that began before the next one. */
function useLatest<T>(value: T) {
  const latest = useRef(value);
  latest.current = value;
  return latest;
}

type Standing = Readonly<{
  view: RecoveryView;
  approvals: string | null;
  checkFailure: string;
  check: () => Promise<void>;
  settle: (next: RecoveryView) => Promise<void>;
}>;

/** Where the recovery stands, read again when the sheet opens and whenever asked. */
function useStanding(
  ports: DeskPorts,
  initial: RecoveryView,
  onChanged: () => Promise<void>,
): Standing {
  const { requestId } = initial;
  const [view, setView] = useState(initial);
  const [approvals, setApprovals] = useState<string | null>(null);
  const checking = useCeremonyFailure(
    "trusted-contacts:recovery-status",
    "Recovery",
  );
  const changed = useLatest(onChanged);
  const show = useCallback(
    async (next: RecoveryView) => {
      setView(next);
      setApprovals(
        wantsApprovals(next) ? await approvalsPacket(ports, requestId) : null,
      );
    },
    [ports, requestId],
  );
  const settle = useCallback(
    async (next: RecoveryView) => {
      await show(next);
      await changed.current();
    },
    [show, changed],
  );
  const { run } = checking;
  const check = useCallback(async () => {
    await run(async () => settle(await recoveryStatus(ports, requestId)));
  }, [run, settle, ports, requestId]);
  useEffect(() => {
    // Standing as of now, not as of when the list was read.
    void run(async () => show(await recoveryStatus(ports, requestId)));
  }, [run, show, ports, requestId]);
  return { view, approvals, checkFailure: checking.message, check, settle };
}

/** The answers contacts send back: each is checked by the ledger, and a refused one says why. */
function useAnswers(
  ports: DeskPorts,
  requestId: string,
  settle: Standing["settle"],
  onAnswer: () => void,
) {
  const [refused, setRefused] = useState<readonly string[]>([]);
  useFailureNotice(
    "trusted-contacts:recovery-refused",
    "Recovery",
    refused.join(" "),
    "err",
    { occurrence: refused },
  );
  const add = useCallback(
    async (text: string) => {
      const result = await ingest(ports, requestId, text);
      setRefused([
        ...new Set(
          result.outcomes.flatMap((outcome) =>
            outcome.ok ? [] : [sentence(outcome.message)],
          ),
        ),
      ]);
      onAnswer();
      await settle(result.view);
    },
    [ports, requestId, settle, onAnswer],
  );
  return { refused, add };
}

/** The two ways a recovery ends: opened with what the contacts released, or given up. */
function useEnding(
  input: RecoveryRunInput,
  standing: Standing,
  ports: DeskPorts,
) {
  const { requestId } = input.initial;
  const { view, check } = standing;
  const [askAgain, setAskAgain] = useState<readonly Contact[]>([]);
  const [opening, setOpening] = useState(false);
  const [giving, setGiving] = useState(false);
  const opened = useCeremonyFailure(
    "trusted-contacts:recovery-open",
    "Recovery",
  );
  const gaveUp = useCeremonyFailure(
    "trusted-contacts:recovery-give-up",
    "Recovery",
  );
  const parent = useLatest(input);
  const { run: openRun, clear: clearOpen } = opened;
  const { run: giveUpRun } = gaveUp;

  const reset = useCallback(() => {
    setAskAgain([]);
    clearOpen();
  }, [clearOpen]);

  const open = useCallback(async () => {
    setOpening(true);
    setAskAgain([]);
    const done = await openRun(async () => {
      try {
        return await openRecovery(ports, requestId);
      } catch (error) {
        if (error instanceof RecoveryError) {
          setAskAgain(askAgainWho(view, error.guardianIds));
        }
        throw error;
      }
    });
    if (done.ok) {
      await parent.current.onOpened({
        requestId,
        label: view.label,
        text: documentText(done.value),
      });
    } else {
      // A release that did not open was dropped: the standing has changed.
      await check();
    }
    setOpening(false);
  }, [openRun, ports, requestId, view, check, parent]);

  const giveUp = useCallback(async () => {
    setGiving(true);
    const done = await giveUpRun(() => abandonRecovery(ports, requestId));
    setGiving(false);
    if (done.ok) await parent.current.onGaveUp();
  }, [giveUpRun, ports, requestId, parent]);

  return {
    askAgain,
    openFailure: opened.message,
    giveUpFailure: gaveUp.message,
    opening,
    giving,
    reset,
    open,
    giveUp,
  };
}

export function useRecovery(input: RecoveryRunInput): RecoveryRun {
  const { ports } = input.desk;
  const standing = useStanding(ports, input.initial, input.onChanged);
  const ending = useEnding(input, standing, ports);
  const answers = useAnswers(
    ports,
    input.initial.requestId,
    standing.settle,
    ending.reset,
  );
  return {
    view: standing.view,
    approvals: standing.approvals,
    refused: answers.refused,
    askAgain: ending.askAgain,
    checkFailure: standing.checkFailure,
    openFailure: ending.openFailure,
    giveUpFailure: ending.giveUpFailure,
    opening: ending.opening,
    giving: ending.giving,
    add: answers.add,
    check: standing.check,
    open: ending.open,
    giveUp: ending.giveUp,
  };
}
