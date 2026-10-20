/**
 * The share sheet's body (ADR 0150 as amended): one key starts a live
 * session, and everything else is advanced and stays folded away.
 *
 * The press needs no fields: it shares the vault whose name the key sits
 * beside, under the form's own defaults — values copy only, a link and a
 * code to get in, an hour. Choosing items instead, another policy, or
 * the routes (a relay of one's own: STUN/TURN, carriers) lives under
 * Advanced, collapsed until asked for. Routes are read as a session
 * starts, so Advanced is where a relay is named before the press.
 *
 * The session belongs to the tab, not to this sheet: closing the sheet
 * keeps it running, and locking the vault ends it.
 */

import {
  projectsState,
  subscribeProjects,
} from "@opensesame/app-core/lib/projects.js";
import { vaultLabel } from "@opensesame/app-core/lib/vaults.js";
import { useRef, useSyncExternalStore } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { IconPlay } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { firstControl } from "../../lib/focus.js";
import { LiveHostForm } from "./LiveHostForm.js";
import { LiveHostSession } from "./LiveHostSession.js";
import { LiveRoutesPanel } from "./LiveRoutesPanel.js";
import { useLandOnChange } from "./live-focus.js";
import { useLiveHost } from "./live-hooks.js";
import { startInput, useStartSession } from "./live-start.js";
import "./live.css";

/** The open vault's name, as the prompt beside the Share key spells it. */
export function useVaultName(): string {
  const state = useSyncExternalStore(subscribeProjects, projectsState);
  const active =
    state.projects.find((project) => project.id === state.activeId) ??
    state.projects[0];
  return active ? vaultLabel(active) : "personal";
}

const NO_ITEMS: ReadonlySet<string> = new Set();

export function LiveSharePanel() {
  const { host, state } = useLiveHost();
  const running = Boolean(host && state?.status === "live");
  const name = useVaultName();
  const { starting, failed, start } = useStartSession();
  const body = useRef<HTMLDivElement>(null);
  const startKey = useRef<HTMLButtonElement>(null);
  // Starting and ending swap the key and the session for one another, and
  // the key that was pressed goes with the one that was showing.
  useLandOnChange(running ? "live" : "form", () =>
    running
      ? (body.current?.querySelector('[aria-label="Copy the link"]') ??
        firstControl(body.current))
      : startKey.current,
  );
  const quickStart = () =>
    start(
      startInput({
        title: name.slice(0, 64),
        scope: "vault",
        chosen: NO_ITEMS,
        policy: "use",
        admission: "invite",
        minutes: 60,
        devices: false,
      }),
    );
  return (
    <div className="setup__stack" ref={body}>
      {running && host && state ? (
        <LiveHostSession host={host} state={state} />
      ) : (
        <>
          <FormCommit
            label="Start sharing"
            disabled={starting}
            busy={starting}
            icon={<IconPlay size={18} />}
            buttonRef={startKey}
            onClick={quickStart}
          />
          {failed ? <StatusMark tone="err" label={failed} /> : null}
        </>
      )}
      <details className="live-advanced">
        <summary>Advanced</summary>
        <div className="live-advanced__body setup__stack">
          {running ? null : <LiveHostForm />}
          <LiveRoutesPanel />
        </div>
      </details>
    </div>
  );
}
