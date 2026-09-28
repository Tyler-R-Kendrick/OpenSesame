/**
 * A live session this tab is hosting (ADR 0148 §2–§5): the link and code to
 * pass along, who is asking and who is in, every value handed out, and the
 * key that ends it for everyone.
 *
 * The link is shown masked, like any bearer; the code goes another way (a
 * call, a message), so it is drawn in the clear.
 */

import type {
  Guest,
  HostState,
  LiveHost,
} from "@opensesame/app-core/lib/live/host.js";
import { formatLiveLink } from "@opensesame/app-core/lib/live/link.js";
import { endHosting } from "@opensesame/app-core/lib/live/session.js";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import { IconCheck, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useVault } from "../../lib/vault/hooks.js";
import {
  type Standing,
  formatRemaining,
  liveUiSeams,
  useRemaining,
} from "./live-hooks.js";

const GUEST_MARK = {
  asking: { tone: "warn", label: "Asking to join" },
  connecting: { tone: "idle", label: "Connecting" },
  joined: { tone: "ok", label: "In the session" },
  refused: { tone: "err", label: "Refused" },
  gone: { tone: "idle", label: "Left" },
} satisfies Record<Guest["state"], Standing>;

function GuestRow({ host, guest }: { host: LiveHost; guest: Guest }) {
  const mark = GUEST_MARK[guest.state];
  const live =
    guest.state === "asking" ||
    guest.state === "connecting" ||
    guest.state === "joined";
  return (
    <div className="vault-row">
      <div className="vault-row__body">
        <span className="vault-row__text">
          <span className="vault-row__name">{guest.name}</span>
          {guest.note ? (
            <span className="vault-row__meta">{guest.note}</span>
          ) : null}
        </span>
        <StatusMark tone={mark.tone} label={mark.label} />
      </div>
      {guest.state === "asking" ? (
        <button
          type="button"
          className="icon-btn"
          aria-label={`Let ${guest.name} in`}
          title={`Let ${guest.name} in`}
          onClick={() => void host.admit(guest.key)}
        >
          <IconCheck size={16} />
        </button>
      ) : null}
      {live ? (
        <button
          type="button"
          className="icon-btn"
          aria-label={
            guest.state === "asking"
              ? `Turn ${guest.name} away`
              : `Remove ${guest.name}`
          }
          title={
            guest.state === "asking"
              ? `Turn ${guest.name} away`
              : `Remove ${guest.name}`
          }
          onClick={() => void host.refuse(guest.key)}
        >
          <IconX size={16} />
        </button>
      ) : null}
    </div>
  );
}

function Log({ state }: { state: HostState }) {
  const { items } = useVault();
  if (state.log.length === 0) return null;
  const names = new Map(state.guests.map((guest) => [guest.key, guest.name]));
  const itemName = (id: string) =>
    items.find((item) => item.id === id)?.name ?? id;
  return (
    <ul className="live-log" aria-label="Handed out">
      {[...state.log].reverse().map((entry) => (
        <li key={`${entry.at}:${entry.guest}:${entry.item}:${entry.field}`}>
          <StatusMark
            tone={entry.what === "denied" ? "err" : "idle"}
            label={`${new Date(entry.at).toLocaleTimeString()} · ${names.get(entry.guest) ?? "?"} · ${entry.what} · ${itemName(entry.item)} ${entry.field}`}
          />
        </li>
      ))}
    </ul>
  );
}

export function LiveHostSession({
  host,
  state,
}: { host: LiveHost; state: HostState }) {
  const { copied, failed, copy } = useCopyFeedback();
  const left = useRemaining(host.expiresAt);
  const link = formatLiveLink(liveUiSeams.joinUrl(), host.link);
  return (
    <div className="setup__stack">
      <div className="live-status">
        <StatusMark tone="ok" label="Live" />
        <span className="vault-row__meta">{formatRemaining(left)}</span>
        <button
          type="button"
          className="icon-btn"
          aria-label="End the session for everyone"
          title="End the session for everyone"
          onClick={endHosting}
        >
          <IconX size={16} />
        </button>
      </div>
      <FieldRow
        label="Link"
        actions={
          <CopyButton
            value={link}
            label="the link"
            fieldKey="live-link"
            copied={copied}
            failed={failed}
            onCopy={copy}
          />
        }
      >
        <ConcealedValue value={link} label="Link" revealed={false} />
      </FieldRow>
      {host.code ? (
        <FieldRow
          label="Code"
          actions={
            <CopyButton
              value={host.code}
              label="the code"
              fieldKey="live-code"
              copied={copied}
              failed={failed}
              onCopy={copy}
            />
          }
        >
          <span className="frow__value live-code">{host.code}</span>
        </FieldRow>
      ) : null}
      {state.guests.map((guest) => (
        <GuestRow key={guest.key} host={host} guest={guest} />
      ))}
      <Log state={state} />
    </div>
  );
}
