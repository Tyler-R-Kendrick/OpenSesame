/**
 * Settings › Notifications (ADR 0084; ADR 0140 D9): where the Identity API
 * tells you about requests — the channels this deployment has, the
 * destinations you connected, and the order each kind of prompt tries them.
 * It replaces `apps/ceremonies`' `/notifications` page.
 *
 * The Form is a view of the category's files (ADR 0134): every key here is a
 * write through the routing session, the same road the file viewer's save
 * takes, and every panel head opens the file it is drawn from.
 *
 * Gated per panel on what it needs (ADR 0090): with no Identity API
 * configured there is nothing to read, and the page shows the one channel
 * that needs nothing — the inbox — without naming a service that is not
 * there. With one configured and no Identity session, it asks to connect.
 *
 * ADR 0084's standing sentence stays on the page: "the settings screen says
 * so in as many words" is the ADR's, and it outranks DESIGN.md's rule against
 * explainer prose here.
 */

import {
  ASSURANCE_NOTE,
  channelName,
} from "@opensesame/app-core/lib/notification-routing/channels.js";
import { connectableChannels } from "@opensesame/app-core/lib/notification-routing/routing.js";
import { RoutingError } from "@opensesame/app-core/lib/notification-routing/transport.js";
import {
  BINDINGS_FILE,
  CHANNELS_FILE,
} from "@opensesame/app-core/sections/settings/notification-routing-files.js";
import {
  NOTIFICATION_CLASSES,
  type NotificationChannelKind,
} from "@opensesame/os-domain";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useConnect, useIdentitySession } from "../../bindings/identity.js";
import { IconKey, ReloadKey } from "../../components/IconKey.js";
import {
  IconExternal,
  IconLogin,
  IconPlus,
  IconX,
} from "../../components/Icons.js";
import { StatusMark, type StatusTone } from "../../components/StatusMark.js";
import { useIdentityConfigured } from "../../lib/use-configured.js";
import { useOnline } from "../../lib/use-online.js";
import { OpenFileKey } from "../../sections/settings/files/OpenFileKey.js";
import { ClassPanel } from "./ClassPanel.js";
import type { RoutingSession, RoutingView } from "./session.js";
import "./notifications.css";

type Mark = { tone: StatusTone; label: string };

const SIGN_IN = new RoutingError(401, "unauthorized").message;

function outcome(view: RoutingView): Mark | null {
  if (view.busy) return null;
  if (view.error) return { tone: "err", label: view.error };
  if (view.status) return { tone: "ok", label: view.status };
  return null;
}

/** A destination's state as a glyph: live, waiting, or delivering nothing. */
function bindingTone(state: string): StatusTone {
  if (state === "active") return "ok";
  if (state === "pending") return "warn";
  return "err";
}

/** The one channel that needs no service: shown when none is configured. */
function InboxOnly() {
  return (
    <section className="panel notif" id="notif-channels">
      <div className="panel__head">
        <h2>Channels</h2>
      </div>
      <div className="panel__body">
        <ul className="notif-rows">
          <li className="notif-row">
            <span className="notif-row__name">{channelName("in_app")}</span>
            <StatusMark tone="ok" label="Always in the route" />
          </li>
        </ul>
      </div>
    </section>
  );
}

function ChannelsPanel({
  view,
  session,
  mark,
}: {
  view: RoutingView;
  session: RoutingSession;
  mark: Mark | null;
}) {
  const online = useOnline();
  const { connect, connecting } = useConnect();
  const { signedOut } = view;
  const head = signedOut ? { tone: "warn" as const, label: SIGN_IN } : mark;
  const connectable = new Set<NotificationChannelKind>(
    view.state ? connectableChannels(view.state).map((row) => row.kind) : [],
  );
  return (
    <section className="panel notif" id="notif-channels">
      <div className="panel__head">
        <h2>Channels</h2>
        <div className="actions">
          {head ? <StatusMark tone={head.tone} label={head.label} /> : null}
          {signedOut ? (
            <IconKey
              small
              label="Connect"
              disabled={connecting || !online}
              onClick={() => void connect()}
            >
              <IconLogin size={15} />
            </IconKey>
          ) : null}
          {view.state ? (
            <OpenFileKey path={CHANNELS_FILE} name="channels.json" />
          ) : null}
          <ReloadKey
            label="Read the channels again"
            disabled={!online}
            onReload={() => session.reload()}
          />
        </div>
      </div>
      <div className="panel__body">
        <p className="notif-standing">{ASSURANCE_NOTE}</p>
        <ul className="notif-rows" aria-busy={view.busy}>
          {(view.state?.channels ?? []).map((row) => (
            <li className="notif-row" key={row.kind}>
              <span className="notif-row__text">
                <span className="notif-row__name">{row.name}</span>
                <span className="notif-row__meta">{row.sentence}</span>
              </span>
              <StatusMark
                tone={row.configured ? "ok" : "idle"}
                label={row.configured ? "Set up here" : "Not set up here"}
              />
              {connectable.has(row.kind) ? (
                <span className="notif-row__keys">
                  <IconKey
                    small
                    label={`Connect ${row.name}`}
                    onClick={() => void session.bind(row.kind)}
                  >
                    <IconPlus size={16} />
                  </IconKey>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Begun({ begun }: { begun: NonNullable<RoutingView["begun"]> }) {
  return (
    <li className="notif-row">
      <span className="notif-row__text">
        <span className="notif-row__name">
          <code>{begun.nonce}</code>
        </span>
        <span className="notif-row__meta">{begun.words}</span>
      </span>
      <StatusMark tone="warn" label="Waiting to be confirmed" />
      {begun.authorizeUrl ? (
        <span className="notif-row__keys">
          <a
            className="icon-btn icon-btn--sm"
            href={begun.authorizeUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Finish connecting where it opens"
            title="Finish connecting where it opens"
          >
            <IconExternal size={16} />
          </a>
        </span>
      ) : null}
    </li>
  );
}

function DestinationsPanel({
  view,
  session,
  mark,
}: {
  view: RoutingView;
  session: RoutingSession;
  mark: Mark | null;
}) {
  const bindings = view.state?.bindings ?? [];
  return (
    <section className="panel notif" id="notif-destinations">
      <div className="panel__head">
        <h2>Destinations</h2>
        <div className="actions">
          {mark ? <StatusMark tone={mark.tone} label={mark.label} /> : null}
          <OpenFileKey path={BINDINGS_FILE} name="bindings.json" />
        </div>
      </div>
      <div className="panel__body">
        <ul className="notif-rows">
          {view.begun ? <Begun begun={view.begun} /> : null}
          {bindings.map((row) => (
            <li className="notif-row" key={row.id}>
              <span className="notif-row__text">
                <span className="notif-row__name">
                  {row.name}
                  {row.label ? ` · ${row.label}` : ""}
                </span>
              </span>
              <StatusMark
                tone={bindingTone(row.state)}
                label={row.stateSentence}
              />
              <span className="notif-row__keys">
                <IconKey
                  small
                  danger
                  label={`Disconnect ${row.name}${row.label ? ` · ${row.label}` : ""}`}
                  onClick={() => void session.unbind(row.id)}
                >
                  <IconX size={16} />
                </IconKey>
              </span>
            </li>
          ))}
        </ul>
        {bindings.length === 0 && !view.begun ? (
          <p className="hint">
            No destinations connected. Requests wait in the OpenSesame inbox.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The routing session, redrawn on every step it publishes. */
function useRoutingView(session: RoutingSession): RoutingView {
  const configured = useIdentityConfigured();
  const identity = useIdentitySession();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a configured API or a session arriving or leaving reads again
  useEffect(() => {
    session.ensure();
  }, [session, configured, identity]);
  return useSyncExternalStore(session.subscribe, session.view, session.view);
}

export function NotificationsPanel({ session }: { session: RoutingSession }) {
  const configured = useIdentityConfigured();
  const view = useRoutingView(session);
  // Which panel the last key was pressed in: its outcome is marked there.
  const [where, setWhere] = useState<string>("channels");
  const acting = useMemo<RoutingSession>(
    () => ({
      ...session,
      edit: (edit) => {
        setWhere(edit.cls);
        return session.edit(edit);
      },
      bind: (kind) => {
        setWhere("destinations");
        return session.bind(kind);
      },
      unbind: (id) => {
        setWhere("destinations");
        return session.unbind(id);
      },
      reload: () => {
        setWhere("channels");
        session.reload();
      },
    }),
    [session],
  );
  if (!configured) return <InboxOnly />;
  const mark = outcome(view);
  const at = (panel: string) => (where === panel ? mark : null);
  const { state } = view;
  return (
    <>
      <ChannelsPanel view={view} session={acting} mark={at("channels")} />
      {state ? (
        <>
          <DestinationsPanel
            view={view}
            session={acting}
            mark={at("destinations")}
          />
          {NOTIFICATION_CLASSES.map((cls) => (
            <ClassPanel
              key={cls}
              cls={cls}
              state={state}
              session={acting}
              mark={at(cls)}
              busy={view.busy}
            />
          ))}
        </>
      ) : null}
      <output className="visually-hidden" aria-live="polite">
        {mark?.label ?? ""}
      </output>
    </>
  );
}
