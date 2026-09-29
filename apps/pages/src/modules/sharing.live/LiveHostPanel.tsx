/**
 * Settings › Live sessions › Live session (ADR 0150 §2): host one from this tab.
 *
 * Contributed by `sharing.live`, so it exists only while Live sessions is
 * on. The session belongs to the tab, not to this panel: leaving Settings
 * keeps it running, and locking the vault ends it.
 */

import { useRef } from "react";
import { firstControl } from "../../lib/focus.js";
import { GuideTarget } from "../../tutorial/registry/react.jsx";
import { LiveHostForm } from "./LiveHostForm.js";
import { LiveHostSession } from "./LiveHostSession.js";
import { useLandOnChange } from "./live-focus.js";
import { useLiveHost } from "./live-hooks.js";
import "./live.css";

export function LiveHostPanel() {
  const { host, state } = useLiveHost();
  const running = host && state?.status === "live";
  const body = useRef<HTMLDivElement>(null);
  // Starting and ending swap the form and the session for one another, and
  // the key that was pressed goes with the one that was showing.
  useLandOnChange(running ? "live" : "form", () =>
    running
      ? (body.current?.querySelector('[aria-label="Copy the link"]') ??
        firstControl(body.current))
      : document.getElementById("live-title"),
  );
  return (
    <GuideTarget id="settings.live-session">
      <section className="panel" id="live-session">
        <div className="panel__head">
          <div>
            <h2>Live session</h2>
          </div>
        </div>
        <div className="panel__body" ref={body}>
          {running ? (
            <LiveHostSession host={host} state={state} />
          ) : (
            <LiveHostForm />
          )}
        </div>
      </section>
    </GuideTarget>
  );
}
