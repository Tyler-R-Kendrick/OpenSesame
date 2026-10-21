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
import { firstControl } from "../../lib/focus.js";
import { LiveHostForm } from "./LiveHostForm.js";
import { LiveHostSession } from "./LiveHostSession.js";
import { LiveTransportSettings } from "./LiveTransportSettings.js";
import { useLandOnChange } from "./live-focus.js";
import { useLiveHost } from "./live-hooks.js";
import "./live.css";

/** The open vault's name, as the prompt beside the Share key spells it. */
export function useVaultName(): string {
  const state = useSyncExternalStore(subscribeProjects, projectsState);
  const active =
    state.projects.find((project) => project.id === state.activeId) ??
    state.projects[0];
  return active ? vaultLabel(active) : "personal";
}

export function LiveSharePanel() {
  const { host, state } = useLiveHost();
  const running = Boolean(host && state?.status === "live");
  const name = useVaultName();
  const body = useRef<HTMLDivElement>(null);
  // Starting and ending swap the form and the session for one another.
  useLandOnChange(running ? "live" : "form", () =>
    running
      ? (body.current?.querySelector('[aria-label="Copy the link"]') ??
        firstControl(body.current))
      : firstControl(body.current),
  );
  return (
    <div className="setup__stack" ref={body}>
      {running && host && state ? (
        <LiveHostSession host={host} state={state} />
      ) : (
        <LiveHostForm initialTitle={name.slice(0, 64)} />
      )}
      <details className="live-advanced">
        <summary>Advanced</summary>
        <div className="live-advanced__body setup__stack">
          <LiveTransportSettings />
        </div>
      </details>
    </div>
  );
}
