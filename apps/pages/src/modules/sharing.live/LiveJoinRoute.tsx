/**
 * `/live` — joining somebody's live session (ADR 0150 §3–§5).
 *
 * The link arrives from the address bar (boot took it out of history), from
 * the door's road (held in memory across the consent), or pasted here,
 * masked. An invite session also asks for the code the owner passed along
 * another way. The person gives a name — and, if they like, a note — and
 * asks; the owner's tab lets them in or does not. Everything the session
 * shows lives in this tab's memory and goes when it ends.
 *
 * The screen holds no vault key and opens on a locked or empty device
 * (`gate: "any"`).
 */

import {
  takeCapturedLiveLink,
  takePersistedLiveLink,
} from "@opensesame/app-core/lib/join/invite.js";
import {
  type LiveLink,
  parseLiveLink,
  takeHeldLiveLink,
} from "@opensesame/app-core/lib/live/link.js";
import { leaveLive } from "@opensesame/app-core/lib/live/session.js";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { IconChevronLeft, IconX } from "../../components/Icons.js";
import { keyboardIsIdle, landFocus } from "../../lib/focus.js";
import { useLandOnChange } from "./live-focus.js";
import { clearJoinDraft, joinDraft, useLiveGuest } from "./live-hooks.js";
import {
  LiveJoinAskForm,
  LiveJoinSession,
  liveJoinLandingFor,
} from "./live-join-route-parts.js";
import { revealClear } from "./live-reveal.js";
import "./live.css";

export function LiveJoinRoute() {
  const navigate = useNavigate();
  const [held] = useState<LiveLink | null>(() => {
    joinDraft.link =
      takeHeldLiveLink() ??
      takeCapturedLiveLink() ??
      takePersistedLiveLink() ??
      // Last resort: the address still has it because no earlier step got to
      // remove it. This also survives a reload with session storage blocked.
      parseLiveLink(window.location.href) ??
      joinDraft.link;
    return joinDraft.link;
  });
  useEffect(() => {
    if (!window.location.hash.includes("live=")) return;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }, []);
  const { guest, status } = useLiveGuest();
  const over =
    guest !== null && (status?.at === "ended" || status?.at === "unreachable");
  const leave = over ? "Close" : guest ? "Leave the session" : "Close";
  const root = useRef<HTMLDivElement>(null);
  useLandOnChange(guest ? (status?.at ?? "starting") : "ask", () =>
    liveJoinLandingFor(root.current, guest ? status?.at : "ask"),
  );
  useEffect(() => {
    // Creating the joiner's vault, or returning from it to a joined session,
    // mounts a phase that already exists, with no useLandOnChange transition.
    if (!guest || (status?.at !== "request" && status?.at !== "joined")) return;
    const fallback = document.getElementById("main");
    // The shell's navigation key stays mounted across this route change.
    // It handed the keyboard here; another control the person chose did not.
    const fromSessionKey =
      status.at === "joined" &&
      document.activeElement?.matches('button[aria-controls="live-view"]');
    if (
      !keyboardIsIdle() &&
      document.activeElement !== fallback &&
      !fromSessionKey
    )
      return;
    const target = liveJoinLandingFor(root.current, status.at);
    if (landFocus(target) && target) revealClear(target);
  }, [guest, status?.at]);

  return (
    <div className="section__inner live-join" ref={root}>
      <div className="section__head">
        <h1>Join a session</h1>
        {over ? (
          <button
            type="button"
            className="icon-btn"
            id="live-start-over"
            aria-label="Start over"
            title="Start over"
            onClick={leaveLive}
          >
            <IconChevronLeft size={18} />
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          aria-label={leave}
          title={leave}
          onClick={() => {
            leaveLive();
            clearJoinDraft();
            navigate("/");
          }}
        >
          <IconX size={18} />
        </button>
      </div>
      {guest ? <LiveJoinSession /> : <LiveJoinAskForm held={held} />}
    </div>
  );
}
