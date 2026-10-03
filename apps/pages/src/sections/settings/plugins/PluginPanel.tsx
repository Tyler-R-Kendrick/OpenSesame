/**
 * A runtime-installed plugin inside its Settings › Capabilities section
 * (ADR 0150 §7): what the paired daemon says about it, one key that switches
 * it there, and — for the surrogate proxy — its recent tripwires.
 *
 * Drawn by the plugin's own capability module (`agents.surrogate-credentials`,
 * `vault.browser-autofill`), so it exists only while that capability is on.
 * It imports no optional code: the session it draws from is handed in.
 *
 * Installing is not offered here. A plugin is installed at a terminal on the
 * daemon's machine, so an uninstalled one shows its mark and the command.
 */

import type { PluginSession } from "@opensesame/app-core/lib/plugins/session.js";
import { standingOf } from "@opensesame/app-core/lib/plugins/wire.js";
import { useEffect, useSyncExternalStore } from "react";
import { IconPause, IconPlay } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useGuideTarget } from "../../../tutorial/registry/react.jsx";
import { InstallCommand } from "./InstallCommand.js";
import { TripwireList } from "./TripwireList.js";
import { markOf } from "./marks.js";
import "./plugins.css";

function Switch({ session }: { session: PluginSession }) {
  const view = useSyncExternalStore(session.subscribe, session.view);
  const { state } = view;
  if (state === null) return null;
  const on = standingOf(state) === "on";
  // Off and forced off: the daemon's environment wins, so this page cannot
  // turn it on. Not installed: there is nothing to switch.
  const locked = !state.installed || state.forcedOff;
  const label = `${session.plugin.title} on the paired daemon`;
  return (
    <button
      type="button"
      className={`icon-btn${on ? " is-on" : ""}`}
      aria-pressed={on}
      aria-label={label}
      title={label}
      disabled={locked || view.busy}
      onClick={() => void session.toggle()}
    >
      {on ? <IconPause size={16} /> : <IconPlay size={16} />}
    </button>
  );
}

export function PluginPanel({
  session,
  guideId,
}: {
  session: PluginSession;
  /** The tutorial target this panel is (`settings.<capability>`). */
  guideId: string;
}) {
  const view = useSyncExternalStore(session.subscribe, session.view);
  const ref = useGuideTarget<HTMLDivElement>(guideId);
  useEffect(() => {
    session.ensure();
  }, [session]);
  const { plugin } = session;
  const mark = markOf(view);
  const showInstall =
    view.read && (view.state === null || !view.state.installed);
  const showTripwires =
    plugin.notices && view.state?.installed === true && view.read;
  return (
    <div ref={ref} className="conn-tile plugin-tile" id={`plugin-${plugin.id}`}>
      <div className="conn-tile__row plugin-tile__row">
        <span className="conn-tile__copy plugin-tile__copy">
          <span className="conn-tile__name">{plugin.title}</span>
          {view.daemon ? (
            <span className="conn-tile__kind">
              {view.state?.version
                ? `${view.daemon.host} · ${view.state.version}`
                : view.daemon.host}
            </span>
          ) : null}
        </span>
        <StatusMark tone={mark.tone} label={mark.label} />
        <Switch session={session} />
      </div>
      {showInstall ? <InstallCommand command={plugin.installCommand} /> : null}
      {showTripwires ? <TripwireList notices={view.notices} /> : null}
    </div>
  );
}
