/**
 * The people of a hosted live session, from the owner's side (ADR 0150 §3):
 * the field a joiner's request code is pasted into, each asker with Let in
 * and Turn away, and — once let in — the reply code to hand back, until the
 * two browsers connect.
 */

import type {
  Guest,
  LiveHost,
  Received,
} from "@opensesame/app-core/lib/live/host.js";
import { MAX_MISSES } from "@opensesame/app-core/lib/live/host.js";
import { useRef, useState } from "react";
import { CopyButton, useCopyFeedback } from "../../components/FieldRow.js";
import { FieldShell } from "../../components/FieldShell.js";
import {
  IconArrowRight,
  IconCheck,
  IconShare,
  IconX,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { useLandOnChange, useLandWhenSettled } from "./live-focus.js";
import { type Standing, standingMark } from "./live-hooks.js";

const GUEST_MARK = {
  asking: standingMark("warn", "Asking to join"),
  replied: standingMark("idle", "Let in: hand back the reply code"),
  joined: standingMark("ok", "In the session"),
  refused: standingMark("err", "Turned away"),
  gone: standingMark("idle", "Left"),
} satisfies Record<Guest["state"], Standing>;

/** What pasting a code did, as the field's glyph says it; null for a guest. */
function outcome(received: Received): Standing | null {
  switch (received.kind) {
    case "not-a-request":
      return standingMark("err", "Not a request code");
    case "not-this-session":
      return standingMark(
        "err",
        `Not for this session (${received.misses} of ${MAX_MISSES})`,
      );
    case "full":
      return standingMark("warn", "The session is full");
    case "ended":
      return standingMark("idle", "The session has ended");
    case "locked":
      return standingMark("warn", "The session is locked");
    default:
      return null;
  }
}

export function RequestPaste({ host }: { host: LiveHost }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Standing | null>(null);
  // Whatever the paste said, the field is where the next one goes.
  useLandWhenSettled(busy, () => document.getElementById("live-request"));

  async function receive(): Promise<void> {
    setBusy(true);
    try {
      const mark = outcome(await host.receive(text));
      setSaid(mark);
      if (mark === null) setText("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void receive();
      }}
    >
      <FieldShell
        id="live-request"
        label="A request code"
        mono
        autoComplete="off"
        lead={<IconShare size={17} />}
        value={text}
        disabled={busy}
        status={
          said ? <StatusMark tone={said.tone} label={said.label} /> : null
        }
        onValueChange={(next) => {
          setText(next);
          setSaid(null);
        }}
        tail={
          <button
            type="submit"
            className="icon-btn"
            aria-label="Read the request"
            title="Read the request"
            disabled={busy || text.trim().length === 0}
          >
            <IconArrowRight size={16} />
          </button>
        }
      />
    </form>
  );
}

function GuestActions({ host, guest }: { host: LiveHost; guest: Guest }) {
  const { copied, failed, copy } = useCopyFeedback();
  const asking = guest.state === "asking";
  const away = asking ? `Turn ${guest.name} away` : `Remove ${guest.name}`;
  return (
    <>
      {asking ? (
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
      {guest.reply ? (
        <CopyButton
          value={guest.reply}
          label={`the reply code for ${guest.name}`}
          fieldKey={`reply-${guest.key}`}
          copied={copied}
          failed={failed}
          onCopy={copy}
        />
      ) : null}
      <button
        type="button"
        className="icon-btn"
        aria-label={away}
        title={away}
        onClick={() => host.refuse(guest.key)}
      >
        <IconX size={16} />
      </button>
    </>
  );
}

export function GuestRow({ host, guest }: { host: LiveHost; guest: Guest }) {
  const mark = GUEST_MARK[guest.state];
  const row = useRef<HTMLDivElement>(null);
  // Let in leaves the reply code to hand back; turning away or removing
  // leaves the field the next request is pasted into.
  useLandOnChange(guest.state, () =>
    guest.state === "replied"
      ? row.current?.querySelector('[aria-label^="Copy the reply code"]')
      : document.getElementById("live-request"),
  );
  const open =
    guest.state === "asking" ||
    guest.state === "replied" ||
    guest.state === "joined";
  return (
    <div className="vault-row" ref={row}>
      <div className="vault-row__body">
        <span className="vault-row__text">
          <span className="vault-row__name">{guest.name}</span>
          {guest.note ? (
            <span className="vault-row__meta">{guest.note}</span>
          ) : null}
        </span>
        <StatusMark tone={mark.tone} label={mark.label} />
      </div>
      {open ? <GuestActions host={host} guest={guest} /> : null}
    </div>
  );
}
