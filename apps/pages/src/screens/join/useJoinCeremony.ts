/**
 * The join ceremony's state and its calls (ADR 0136).
 *
 * Every press maps to one call in `@opensesame/app-core/lib/join/client`;
 * this hook only orders them, keeps what each answered, and makes sure the
 * ceremony's authority ends with the ceremony: closing, finishing, or the
 * screen going away all drop the browser's approval.
 */

import type { PairingPrompt } from "@opensesame/app-core/lib/browser-pairing.js";
import {
  JoinError,
  type JoinErrorCode,
  askToJoin,
  beginApproval,
  claimInvite,
  configuredEndpoint,
  endJoinAuthority,
  joinAvailable,
  listOpenSessions,
  pollApproval,
  presentInvite,
  resolveEndpoint,
  verifyAt,
} from "@opensesame/app-core/lib/join/client.js";
import {
  acceptedItemIds,
  initialSelection,
  toggleItem,
} from "@opensesame/app-core/lib/join/consent.js";
import {
  type CapturedInvite,
  parseInvite,
} from "@opensesame/app-core/lib/join/invite.js";
import {
  clearPendingJoin,
  readPendingJoin,
  writePendingJoin,
} from "@opensesame/app-core/lib/join/stash.js";
import type {
  JoinOffer,
  JoinReceipt,
  OpenSession,
} from "@opensesame/app-core/lib/join/wire.js";
import { completeSetup, loadSetup } from "@opensesame/app-core/lib/setup.js";
import {
  type JoinRoad,
  type JoinStep,
  nextJoinStep,
} from "@opensesame/app-core/screens/join/join-model.js";
import { useEffect, useRef, useState } from "react";

export const joinCeremonyDependencies = {
  joinAvailable,
  configuredEndpoint,
  presentInvite,
  beginApproval,
  pollApproval,
  verifyAt,
  claimInvite,
  listOpenSessions,
  askToJoin,
  endJoinAuthority,
  readPendingJoin,
  writePendingJoin,
  clearPendingJoin,
  completeSetup,
  loadSetup,
};

const deps = joinCeremonyDependencies;

type Offered = { token: string; offer: JoinOffer };

/** A failure's code; anything that is not a join error reads as silence. */
function codeOf(error: JoinError | null): JoinErrorCode {
  return error?.code ?? "unreachable";
}

function firstError(captured: CapturedInvite | null): JoinErrorCode | null {
  if (captured?.kind === "leaked") return "leaked_invite";
  if (!deps.joinAvailable()) return "unavailable_here";
  return null;
}

function useLatch<T>(initial: T | (() => T)) {
  const [value, set] = useState<T>(initial);
  return { value, set };
}

/** Every value the ceremony holds, seeded from a held offer or an arrival. */
function useJoinFields(captured: CapturedInvite | null) {
  const arrived = captured?.kind === "invite" ? captured.invite : null;
  // A looked-up offer this tab still holds resumes where it stopped — unless
  // a different invite just arrived, which starts its own ceremony.
  const [pending] = useState(() => {
    const held = deps.readPendingJoin();
    return held && (!arrived || arrived.token === held.token) ? held : null;
  });
  return {
    road: useLatch<JoinRoad>("invite"),
    // Authority lives in memory, so even a held offer starts from the top:
    // approval and verification again, then the offer — never presented twice.
    step: useLatch<JoinStep>("where"),
    endpoint: useLatch(
      () => pending?.endpoint ?? arrived?.endpoint ?? deps.configuredEndpoint(),
    ),
    inviteText: useLatch(() => pending?.token ?? arrived?.token ?? ""),
    offered: useLatch<Offered | null>(() =>
      pending ? { token: pending.token, offer: pending.offer } : null,
    ),
    selection: useLatch<ReadonlySet<string>>(() =>
      pending ? initialSelection(pending.offer) : new Set(),
    ),
    prompt: useLatch<PairingPrompt | null>(null),
    code: useLatch(""),
    sessions: useLatch<OpenSession[] | null>(null),
    sessionId: useLatch(""),
    note: useLatch(""),
    receipt: useLatch<JoinReceipt | null>(null),
    claimed: useLatch(0),
    busy: useLatch(false),
    error: useLatch<JoinErrorCode | null>(() => firstError(captured)),
    lifetime: useRef(new AbortController()),
  };
}

type Fields = ReturnType<typeof useJoinFields>;

/** Approval is the operator's to give; poll at the interval they set. */
function useApprovalPoll(f: Fields) {
  const prompt = f.prompt.value;
  const step = f.step.value;
  const { set: setPrompt } = f.prompt;
  const { set: setStep } = f.step;
  const { set: setError } = f.error;
  useEffect(() => {
    if (!prompt || step !== "approve") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const approved = await deps.pollApproval();
        if (stopped) return;
        if (!approved) {
          timer = setTimeout(() => void tick(), prompt.interval * 1000);
          return;
        }
        setPrompt(null);
        setStep("verify");
      } catch (caught) {
        if (stopped) return;
        setPrompt(null);
        setError(codeOf(caught instanceof JoinError ? caught : null));
      }
    };
    timer = setTimeout(() => void tick(), prompt.interval * 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [prompt, step, setPrompt, setStep, setError]);
}

/** An open session's list is read once, as its step arrives. */
function useOpenSessions(f: Fields) {
  const step = f.step.value;
  const { value: sessions, set: setSessions } = f.sessions;
  const endpoint = f.endpoint.value;
  const { set: setError } = f.error;
  useEffect(() => {
    if (step !== "ask" || sessions !== null) return;
    let live = true;
    deps
      .listOpenSessions(endpoint)
      .then((found) => {
        if (live) setSessions(found);
      })
      .catch((caught) => {
        if (!live) return;
        setSessions([]);
        setError(codeOf(caught instanceof JoinError ? caught : null));
      });
    return () => {
      live = false;
    };
  }, [step, sessions, endpoint, setSessions, setError]);
}

async function run(f: Fields, action: () => Promise<void>) {
  f.busy.set(true);
  f.error.set(null);
  try {
    await action();
  } catch (caught) {
    if (!f.lifetime.current.signal.aborted)
      f.error.set(codeOf(caught instanceof JoinError ? caught : null));
  } finally {
    if (!f.lifetime.current.signal.aborted) f.busy.set(false);
  }
}

async function lookUp(f: Fields) {
  const target = resolveEndpoint(f.endpoint.value);
  const invite = parseInvite(f.inviteText.value);
  if (!invite) throw new JoinError("bad_invite");
  // Presenting twice burns the offer: an answer this tab already holds is
  // the answer. Only here, after approval and verification, is it spent.
  const held = deps.readPendingJoin();
  const offer =
    held && held.token === invite.token && held.endpoint === target
      ? held.offer
      : await deps.presentInvite(target, invite.token);
  deps.writePendingJoin({ endpoint: target, token: invite.token, offer });
  f.endpoint.set(target);
  f.offered.set({ token: invite.token, offer });
  f.selection.set(initialSelection(offer));
}

async function finish(f: Fields) {
  deps.clearPendingJoin();
  deps.endJoinAuthority();
  // Joining retires the front door (ADR 0115) — but never overwrites an
  // operator's own record of how this deployment signs people in.
  if (deps.loadSetup() === null) {
    await deps
      .completeSetup({ ways: [], service: false, skipped: [], joined: true })
      .catch(() => undefined);
  }
  f.step.set("done");
}

async function accept(f: Fields) {
  const offered = f.offered.value;
  if (!offered) throw new JoinError("bad_invite");
  f.claimed.set(
    await deps.claimInvite(f.endpoint.value, {
      token: offered.token,
      code: f.code.value,
      acceptedItemIds: acceptedItemIds(offered.offer, f.selection.value),
    }),
  );
  await finish(f);
}

async function ask(f: Fields) {
  f.receipt.set(
    await deps.askToJoin(f.endpoint.value, f.sessionId.value, f.note.value),
  );
  await finish(f);
}

function commit(f: Fields): Promise<void> | undefined {
  const road = f.road.value;
  const step = f.step.value;
  const endpoint = f.endpoint.value;
  switch (step) {
    case "where":
      // Checked here, sent nowhere: nothing leaves the page before approval.
      return run(f, async () => {
        f.endpoint.set(resolveEndpoint(endpoint));
        if (road === "invite" && !parseInvite(f.inviteText.value))
          throw new JoinError("bad_invite");
        f.step.set(nextJoinStep(road, step));
      });
    case "review":
      if (!f.offered.value) return run(f, () => lookUp(f));
      f.step.set(nextJoinStep(road, step));
      return;
    case "approve":
      return run(f, async () => {
        f.prompt.set(await deps.beginApproval(endpoint));
      });
    case "verify":
      // Called from the press itself: the verification window is a popup.
      return run(f, async () => {
        await deps.verifyAt(endpoint, f.lifetime.current.signal);
        f.step.set(nextJoinStep(road, step));
      });
    case "accept":
      return run(f, () => accept(f));
    case "ask":
      return run(f, () => ask(f));
    default:
      return;
  }
}

function edit(f: Fields, field: { set: (next: string) => void }) {
  return (next: string) => {
    field.set(next);
    f.error.set(null);
  };
}

function controls(f: Fields) {
  return {
    commit: () => commit(f),
    chooseRoad(next: JoinRoad) {
      if (f.step.value !== "where" || f.busy.value) return;
      f.road.set(next);
      f.error.set(firstError(null));
    },
    setEndpoint: edit(f, f.endpoint),
    setInviteText(next: string) {
      edit(f, f.inviteText)(next);
      // A pasted link that names its endpoint fills the field, in view,
      // before anything is sent — never silently at the press.
      const named = parseInvite(next)?.endpoint;
      if (named) f.endpoint.set(named);
    },
    toggle(id: string) {
      const offered = f.offered.value;
      if (offered)
        f.selection.set(toggleItem(offered.offer, f.selection.value, id));
    },
    setCode: edit(f, f.code),
    setSessionId: edit(f, f.sessionId),
    setNote: edit(f, f.note),
    /** Back to the first rung, the one place anything can be changed. */
    back() {
      const step = f.step.value;
      if (f.busy.value || step === "where" || step === "done") return;
      f.prompt.set(null);
      f.error.set(null);
      f.step.set("where");
      deps.endJoinAuthority();
    },
    /**
     * Walk away. Authority ends now; a looked-up offer stays in this tab
     * until it expires, because asking the endpoint again would burn it.
     */
    abandon() {
      f.lifetime.current.abort();
      deps.endJoinAuthority();
    },
  };
}

export function useJoinCeremony(captured: CapturedInvite | null) {
  const f = useJoinFields(captured);
  const { lifetime } = f;
  // Authority ends with the screen, whichever way it goes.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      deps.endJoinAuthority();
    };
  }, [lifetime]);
  useApprovalPoll(f);
  useOpenSessions(f);
  return {
    available: deps.joinAvailable(),
    road: f.road.value,
    step: f.step.value,
    endpoint: f.endpoint.value,
    inviteText: f.inviteText.value,
    offer: f.offered.value?.offer ?? null,
    selection: f.selection.value,
    prompt: f.prompt.value,
    code: f.code.value,
    sessions: f.sessions.value,
    sessionId: f.sessionId.value,
    note: f.note.value,
    receipt: f.receipt.value,
    claimed: f.claimed.value,
    busy: f.busy.value,
    waiting: f.prompt.value !== null,
    error: f.error.value,
    ...controls(f),
  };
}

export type JoinCeremony = ReturnType<typeof useJoinCeremony>;
