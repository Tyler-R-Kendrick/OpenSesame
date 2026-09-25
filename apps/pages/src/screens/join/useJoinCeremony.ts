/**
 * The join ceremony's state and its calls (ADR 0136).
 *
 * Every press maps to one call in `@opensesame/app-core/lib/join/client`;
 * this hook only orders them, keeps what each answered, and makes sure the
 * ceremony's authority ends with the ceremony: closing, finishing, or the
 * screen going away all drop the browser's approval.
 *
 * An offer, once looked up, belongs to the endpoint and the invite it was
 * looked up with. Editing either lets go of it in memory — it is never
 * shown under another endpoint, and its bearer and code are never sent to
 * one — and no invite is presented twice from this device.
 */
import { JoinError } from "@opensesame/app-core/lib/join/client.js";
import type { CapturedInvite } from "@opensesame/app-core/lib/join/invite.js";
import { useEffect, useLayoutEffect } from "react";
import { acceptedCount, controls } from "./join-actions.js";
import { type Fields, codeOf, deps, useJoinFields } from "./join-state.js";

export { joinCeremonyDependencies } from "./join-state.js";

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

/** An open session's list is read as its step arrives, and after any change. */
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
/** Rungs that spend the approval: keep it alive while one is on screen. */
const HOLDS_APPROVAL: readonly string[] = ["verify", "review", "ask"];

/** Renew the grant while the person reads (ADR 0136 §2); never past its sitting. */
function useGrantRenewal(f: Fields) {
  const step = f.step.value;
  const endpoint = f.endpoint.value;
  // A layout effect, so leaving a holding step clears the timer in the same
  // commit that draws the next one. A passive effect's cleanup ran later,
  // and a tick already due in between renewed a grant the ceremony had
  // just ended (CI: one renewal after "Asked" was on screen).
  useLayoutEffect(() => {
    if (!HOLDS_APPROVAL.includes(step)) return;
    const timer = setInterval(
      () => void deps.keepJoinAuthority(endpoint),
      15_000,
    );
    return () => clearInterval(timer);
  }, [step, endpoint]);
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
  useGrantRenewal(f);
  return {
    available: deps.joinAvailable(),
    road: f.road.value,
    step: f.step.value,
    endpoint: f.endpoint.value,
    inviteText: f.inviteText.value,
    offer: f.offered.value?.offer ?? null,
    accepted: acceptedCount(f),
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
