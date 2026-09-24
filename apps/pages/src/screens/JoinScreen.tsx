/**
 * Join a session — the other road in (ADR 0115, restored by ADR 0136).
 *
 * Somebody who was invited, or who knows an endpoint whose sessions anyone
 * may ask into, arrives here from the front door's `Join a session` road or
 * straight from an invite link. The ceremony wears setup's frame: a rail of
 * where it is, one question per step, and the `.go` commit at the foot.
 *
 * Nothing here is a gate: closing returns to sign-in with nothing written
 * and no authority left behind. The ladder, the words and every call live in
 * the core (`@opensesame/app-core/lib/join/*`, `screens/join/join-model`).
 */

import type { CapturedInvite } from "@opensesame/app-core/lib/join/invite.js";
import {
  JOIN_RAIL,
  joinErrorField,
  joinErrorText,
  joinSteps,
  joinVerb,
} from "@opensesame/app-core/screens/join/join-model.js";
import { type RefObject, useEffect, useRef } from "react";
import {
  IconArrowRight,
  IconCheck,
  IconChevronLeft,
  IconX,
} from "../components/Icons.js";
import { StatusMark } from "../components/StatusMark.js";
import { Wordmark } from "../components/Wordmark.js";
import { firstControl, keyboardIsIdle, landFocus } from "../lib/focus.js";
import { useSupportRoute } from "../tutorial/session.js";
import { JoinStepBody } from "./join/JoinSteps.js";
import { type JoinCeremony, useJoinCeremony } from "./join/useJoinCeremony.js";
import "./setup.css";
import "./join/join.css";

function blocked(join: JoinCeremony): boolean {
  if (join.busy || join.waiting || !join.available) return true;
  switch (join.step) {
    case "where":
      return (
        !join.endpoint.trim() ||
        (join.road === "invite" && !join.inviteText.trim())
      );
    case "accept":
      return !join.code.trim();
    case "ask":
      return !join.sessionId.trim();
    default:
      return false;
  }
}

function JoinRail({ join }: { join: JoinCeremony }) {
  const steps = joinSteps(join.road);
  const at = steps.indexOf(join.step);
  return (
    <div className="setup__chrome">
      <div className="steps" aria-label="Join steps">
        {steps.map((entry, index) => (
          <div
            key={entry}
            className={`steps__seg${
              index < at ? " is-done" : index === at ? " is-now" : ""
            }`}
            aria-current={index === at ? "step" : undefined}
          >
            <span className="steps__bar" />
            <span className="steps__label">{`${index + 1} · ${JOIN_RAIL[entry]}`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The mark by the commit: a failure no field owns, or the operator's wait. */
function Outcome({ join }: { join: JoinCeremony }) {
  const loose =
    join.error && joinErrorField(join.error) === null ? join.error : null;
  return (
    <output className="join__outcome" aria-live="polite">
      {loose ? (
        <StatusMark tone="err" label={joinErrorText(loose)} />
      ) : join.waiting ? (
        <StatusMark tone="idle" label="Waiting for the operator" />
      ) : null}
    </output>
  );
}

function JoinFoot({
  join,
  goRef,
  onDone,
}: {
  join: JoinCeremony;
  goRef: RefObject<HTMLButtonElement | null>;
  onDone: () => void;
}) {
  const done = join.step === "done";
  const verb = joinVerb(join.road, join.step, {
    busy: join.busy,
    waiting: join.waiting,
    asked: join.receipt !== null,
    offered: join.offer !== null,
  });
  return (
    <div className="setup__foot">
      <div className="setup__foot-start">
        <button
          type="button"
          className="icon-btn"
          disabled={join.busy || join.step === "where" || done}
          aria-label="Start over"
          title="Start over"
          onClick={join.back}
        >
          <IconChevronLeft size={18} />
        </button>
        <Outcome join={join} />
      </div>
      <div className="setup__foot-end">
        <div className="go-row">
          <button
            ref={goRef}
            type="button"
            className="go"
            disabled={!done && blocked(join)}
            aria-busy={join.busy || join.waiting}
            aria-label={verb}
            title={verb}
            onClick={() => {
              if (done) onDone();
              else void join.commit();
            }}
          >
            {done || join.step === "accept" ? (
              <IconCheck size={18} />
            ) : (
              <IconArrowRight size={18} />
            )}
          </button>
          <span className="go-verb" aria-hidden="true">
            {verb}
          </span>
        </div>
      </div>
    </div>
  );
}

export function JoinScreen({
  captured,
  configured,
  onDone,
}: {
  /** An invite the address bar carried, already taken out of it. */
  captured: CapturedInvite | null;
  /** This deployment's own endpoint, so another one can be flagged. */
  configured: string;
  /** Back to sign-in — finished, or walked away from. */
  onDone: () => void;
}) {
  useSupportRoute("/unlock");
  const join = useJoinCeremony(captured);
  const goRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLElement>(null);

  const landed = useRef("");

  // Every step owns its landing: the commit when it can be pressed, else the
  // first thing to fill in. A press that disabled the commit and then failed
  // leaves the keyboard nowhere, so an idle keyboard is landed again too.
  useEffect(() => {
    if (join.busy) return;
    const at = `${join.road}:${join.step}`;
    if (landed.current === at && !keyboardIsIdle()) return;
    landed.current = at;
    const go = goRef.current;
    if (go && !go.disabled && landFocus(go)) return;
    landFocus(firstControl(bodyRef.current));
  }, [join.step, join.road, join.busy]);

  return (
    <div className="setup join">
      <div className="setup__frame">
        <div className="setup__bar">
          <Wordmark className="setup__wordmark" />
          <button
            type="button"
            className="icon-btn setup__back"
            aria-label="Close"
            title="Close"
            onClick={() => {
              join.abandon();
              onDone();
            }}
          >
            <IconX size={18} />
          </button>
        </div>
        <JoinRail join={join} />
        <main className="setup__body" id="main" ref={bodyRef}>
          <JoinStepBody join={join} configured={configured} />
        </main>
        <JoinFoot join={join} goRef={goRef} onDone={onDone} />
      </div>
    </div>
  );
}
