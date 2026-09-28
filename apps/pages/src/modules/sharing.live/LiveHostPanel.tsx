/**
 * Settings › Vaults › Live session (ADR 0148 §2): host one from this tab.
 *
 * Contributed by `sharing.live`, so it exists only while Live sessions is
 * on. The session belongs to the tab, not to this panel: leaving Settings
 * keeps it running, and locking the vault ends it.
 */

import { GuideTarget } from "../../tutorial/registry/react.jsx";
import { LiveHostForm } from "./LiveHostForm.js";
import { LiveHostSession } from "./LiveHostSession.js";
import { useLiveHost } from "./live-hooks.js";
import "./live.css";

export function LiveHostPanel() {
  const { host, state } = useLiveHost();
  const running = host && state?.status === "live";
  return (
    <GuideTarget id="settings.live-session">
      <section className="panel" id="live-session">
        <div className="panel__head">
          <div>
            <h2>Live session</h2>
          </div>
        </div>
        <div className="panel__body">
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
