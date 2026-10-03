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
 * daemon's machine, so an uninstalled one shows its mark and the command, and
 * a forced-off one its mark alone: neither draws a switch, because the page
 * has nothing to switch.
 * Pairing is: with no daemon paired, the tile takes the code
 * `opensesame plugins pair --origin …` printed there, and once paired it
 * carries one key that forgets the pairing.
 */

import type { PluginSession } from "@opensesame/app-core/lib/plugins/session.js";
import { standingOf } from "@opensesame/app-core/lib/plugins/wire.js";
import { type RefObject, useEffect, useRef, useSyncExternalStore } from "react";
import { IconPause, IconPlay, IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useVault } from "../../../lib/vault/hooks.js";
import { useGuideTarget } from "../../../tutorial/registry/react.jsx";
import { InstallCommand } from "./InstallCommand.js";
import { PairForm } from "./PairForm.js";
import { TripwireList } from "./TripwireList.js";
import { markOf } from "./marks.js";
import { useFocusHandoff } from "./useFocusHandoff.js";
import "./plugins.css";

type Home = RefObject<HTMLElement | null>;

function Switch({ session, home }: { session: PluginSession; home: Home }) {
  const view = useSyncExternalStore(session.subscribe, session.view);
  const handoff = useFocusHandoff<HTMLButtonElement>(home);
  const { state } = view;
  if (state === null) return null;
  const on = standingOf(state) === "on";
  // A row acts, or it is not drawn (ADR 0150, settings rows act or are
  // absent). Forced off: the daemon's environment wins, so this page cannot
  // turn it on. Not installed: there is nothing to switch. Either way the
  // tile's mark says why, and the key is absent rather than disabled. While
  // a switch is in flight the key stays, busy, so focus stays on it; the
  // session ignores a press made meanwhile.
  if (!state.installed || state.forcedOff) return null;
  const label = `${session.plugin.title} on the paired daemon`;
  return (
    <button
      ref={handoff}
      type="button"
      className={`icon-btn${on ? " is-on" : ""}`}
      aria-pressed={on}
      aria-label={label}
      title={label}
      aria-busy={view.busy || undefined}
      onClick={() => void session.toggle()}
    >
      {on ? <IconPause size={16} /> : <IconPlay size={16} />}
    </button>
  );
}

const FORGET = "Forget the paired daemon";

function Forget({ session, home }: { session: PluginSession; home: Home }) {
  const view = useSyncExternalStore(session.subscribe, session.view);
  const handoff = useFocusHandoff<HTMLButtonElement>(home);
  if (view.daemon === null || !session.pairable) return null;
  return (
    <button
      ref={handoff}
      type="button"
      className="icon-btn"
      aria-label={FORGET}
      title={FORGET}
      aria-busy={view.busy || undefined}
      onClick={() => void session.forget()}
    >
      <IconX size={16} />
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
  const home = useRef<HTMLSpanElement>(null);
  // Whether a pairing could be kept moves with the vault being open.
  useVault();
  useEffect(() => {
    session.ensure();
  }, [session]);
  // No daemon paired and no way to pair one here (no open vault to keep the
  // key in, or an origin that may not hold local authority): the tile would be
  // a name and a mark nobody can act on, so it is not drawn (ADR 0158).
  if (view.daemon === null && !session.canPair()) return null;
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
          <span className="conn-tile__name" ref={home} tabIndex={-1}>
            {plugin.title}
          </span>
          {view.daemon ? (
            <span className="conn-tile__kind">
              {view.state?.version
                ? `${view.daemon.host} · ${view.state.version}`
                : view.daemon.host}
            </span>
          ) : null}
        </span>
        <StatusMark tone={mark.tone} label={mark.label} />
        <Switch session={session} home={home} />
        <Forget session={session} home={home} />
      </div>
      {view.daemon === null && session.pairable ? (
        <PairForm session={session} home={home} />
      ) : null}
      {showInstall ? <InstallCommand command={plugin.installCommand} /> : null}
      {showTripwires ? <TripwireList notices={view.notices} /> : null}
    </div>
  );
}
