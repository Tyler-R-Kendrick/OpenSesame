/**
 * One kind of prompt's order (ADR 0084 §3): the channels it tries, first to
 * last, each marked with what the server's route did with it, and the keys
 * that reorder, remove and add. Every key is a write to `routing.json`
 * through the session; nothing here holds the order itself.
 *
 * Add offers only what the model says a class may still add
 * (`addableChannels`): configured, able to notify, not listed, and not
 * refused by policy for this class. The model refuses the same edit if it
 * arrives any other way.
 */

import {
  CLASS_LABELS,
  type EffectiveRoute,
  channelName,
} from "@opensesame/app-core/lib/notification-routing/channels.js";
import { preferenceFor } from "@opensesame/app-core/lib/notification-routing/document.js";
import {
  type RoutingState,
  addableChannels,
} from "@opensesame/app-core/lib/notification-routing/routing.js";
import { ROUTING_FILE } from "@opensesame/app-core/sections/settings/notification-routing-files.js";
import type {
  NotificationChannelKind,
  NotificationClass,
} from "@opensesame/os-domain";
import { useEffect, useRef, useState } from "react";
import { IconKey } from "../../components/IconKey.js";
import {
  IconChevronDown,
  IconChevronUp,
  IconPlus,
  IconX,
} from "../../components/Icons.js";
import { StatusMark, type StatusTone } from "../../components/StatusMark.js";
import { OpenFileKey } from "../../sections/settings/files/OpenFileKey.js";
import type { RoutingSession } from "./session.js";

type Mark = { tone: StatusTone; label: string };

/** What the route did with a listed channel, as a glyph and its sentence. */
export function routeMark(
  route: EffectiveRoute | undefined,
  kind: NotificationChannelKind,
): Mark {
  const step = route?.steps.find((entry) => entry.kind === kind);
  if (step) return { tone: "ok", label: `Used: ${step.sentence}` };
  const left = route?.excluded.find((entry) => entry.kind === kind);
  if (left)
    return { tone: left.refusedByPolicy ? "err" : "warn", label: left.why };
  return { tone: "idle", label: "Not read yet" };
}

const keyId = (cls: string, kind: string, what: string) =>
  `notif-${cls}-${kind}-${what}`;

/**
 * Keep the focus on the row a key moved, on a key that still works, once
 * the save landed and the row is where the server has it.
 */
function useRefocus(busy: boolean) {
  const want = useRef<string[]>([]);
  useEffect(() => {
    const ids = want.current;
    if (busy || ids.length === 0) return;
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node instanceof HTMLButtonElement && !node.disabled) {
        node.focus();
        want.current = [];
        return;
      }
    }
  });
  return (ids: string[]) => {
    want.current = ids;
  };
}

function OrderRow({
  cls,
  kind,
  index,
  count,
  route,
  session,
  refocus,
}: {
  cls: NotificationClass;
  kind: NotificationChannelKind;
  index: number;
  count: number;
  route: EffectiveRoute | undefined;
  session: RoutingSession;
  refocus: (ids: string[]) => void;
}) {
  const name = channelName(kind);
  const label = CLASS_LABELS[cls];
  const mark = routeMark(route, kind);
  const move = (direction: -1 | 1) => {
    const first = direction === -1 ? "up" : "down";
    const other = direction === -1 ? "down" : "up";
    refocus([keyId(cls, kind, first), keyId(cls, kind, other)]);
    void session.edit({ kind: "move", cls, index, direction });
  };
  return (
    <li className="notif-row">
      <span className="notif-row__name">
        {index + 1}. {name}
      </span>
      <StatusMark tone={mark.tone} label={mark.label} />
      <span className="notif-row__keys">
        <IconKey
          small
          id={keyId(cls, kind, "up")}
          label={`Move ${name} earlier for ${label}`}
          disabled={index === 0}
          onClick={() => move(-1)}
        >
          <IconChevronUp size={16} />
        </IconKey>
        <IconKey
          small
          id={keyId(cls, kind, "down")}
          label={`Move ${name} later for ${label}`}
          disabled={index === count - 1}
          onClick={() => move(1)}
        >
          <IconChevronDown size={16} />
        </IconKey>
        {kind === "in_app" ? null : (
          <IconKey
            small
            danger
            label={`Remove ${name} from ${label}`}
            onClick={() => {
              refocus([`notif-${cls}-add-key`, `notif-${cls}-head`]);
              void session.edit({ kind: "remove", cls, channel: kind });
            }}
          >
            <IconX size={16} />
          </IconKey>
        )}
      </span>
    </li>
  );
}

function AddChannel({
  cls,
  state,
  session,
}: {
  cls: NotificationClass;
  state: RoutingState;
  session: RoutingSession;
}) {
  const offered = addableChannels(state, cls);
  const [picked, setPicked] = useState<string>("");
  const chosen =
    offered.find((row) => row.kind === picked) ?? offered[0] ?? null;
  if (chosen === null) return null;
  const id = `notif-${cls}-add`;
  return (
    <form
      className="notif-add"
      onSubmit={(event) => {
        event.preventDefault();
        void session.edit({ kind: "add", cls, channel: chosen.kind });
      }}
    >
      <label htmlFor={id}>Add a channel</label>
      <div className="field-inline">
        <select
          id={id}
          value={chosen.kind}
          onChange={(event) => setPicked(event.target.value)}
        >
          {offered.map((row) => (
            <option key={row.kind} value={row.kind}>
              {row.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          id={`${id}-key`}
          className="icon-btn"
          aria-label={`Add ${chosen.name} to ${CLASS_LABELS[cls]}`}
          title={`Add ${chosen.name} to ${CLASS_LABELS[cls]}`}
        >
          <IconPlus size={16} />
        </button>
      </div>
    </form>
  );
}

function FanOut({
  cls,
  on,
  session,
}: {
  cls: NotificationClass;
  on: boolean;
  session: RoutingSession;
}) {
  const label = "Tell me on every destination that works, not just the first";
  return (
    <div className="sw">
      <span className="sw__name">Every destination that works</span>
      <button
        type="button"
        className="toggle"
        role="switch"
        aria-checked={on}
        aria-label={label}
        title={label}
        onClick={() => void session.edit({ kind: "fanOut", cls, fanOut: !on })}
      />
    </div>
  );
}

export function ClassPanel({
  cls,
  state,
  session,
  mark,
  busy,
}: {
  cls: NotificationClass;
  state: RoutingState;
  session: RoutingSession;
  /** The outcome of the last key pressed in this panel, if any. */
  mark: Mark | null;
  busy: boolean;
}) {
  const refocus = useRefocus(busy);
  const preference = preferenceFor(state.document, cls);
  const route = state.routes[cls];
  const listed = preference.channels;
  const headId = `notif-${cls}-head`;
  return (
    <section className="panel notif" aria-labelledby={headId}>
      <div className="panel__head">
        <h2 id={headId} tabIndex={-1}>
          {CLASS_LABELS[cls]}
        </h2>
        <div className="actions">
          {mark ? <StatusMark tone={mark.tone} label={mark.label} /> : null}
          <OpenFileKey path={ROUTING_FILE} name="routing.json" />
        </div>
      </div>
      <div className="panel__body">
        <ol className="notif-rows">
          {listed.map((kind, index) => (
            <OrderRow
              key={kind}
              cls={cls}
              kind={kind}
              index={index}
              count={listed.length}
              route={route}
              session={session}
              refocus={refocus}
            />
          ))}
          {listed.includes("in_app") ? null : (
            <li className="notif-row">
              <span className="notif-row__name">
                {listed.length + 1}. {channelName("in_app")}
              </span>
              <StatusMark tone="ok" label="Always last in the route" />
            </li>
          )}
        </ol>
        <AddChannel cls={cls} state={state} session={session} />
        {cls === "security_event" ? (
          <FanOut cls={cls} on={preference.fanOut} session={session} />
        ) : null}
      </div>
    </section>
  );
}
