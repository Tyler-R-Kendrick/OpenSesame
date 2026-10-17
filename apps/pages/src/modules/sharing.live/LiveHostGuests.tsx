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
import { createLivePeerJoinApproval } from "@opensesame/app-core/lib/live/peer-trust-peering.js";
import { rememberTrustedPeer } from "@opensesame/app-core/lib/peer-trust/peers.js";
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
    case "no-devices":
      return standingMark("warn", "This session does not let devices ask");
    case "no-relay":
      return standingMark("warn", "This session has no relay for a device");
    case "ended":
      return standingMark("idle", "The session has ended");
    case "locked":
      return standingMark("warn", "The session is locked");
    case "duplicate":
      return standingMark("err", "Already asking with this key");
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

function GuestActions({
  host,
  guest,
  canCompare,
  onCompare,
  onRefuse,
}: {
  host: LiveHost;
  guest: Guest;
  canCompare: boolean;
  onCompare: () => void;
  onRefuse: () => void;
}) {
  const { copied, failed, copy } = useCopyFeedback();
  const asking = guest.state === "asking";
  const compare = Boolean(guest.sas);
  const admitLabel = compare
    ? `Yes, they match for ${guest.name}`
    : `Let ${guest.name} in`;
  const away = asking ? `Turn ${guest.name} away` : `Remove ${guest.name}`;
  const showAdmit = asking && (!compare || canCompare);
  return (
    <>
      {showAdmit ? (
        <button
          type="button"
          className="icon-btn"
          aria-label={admitLabel}
          title={admitLabel}
          onClick={() => {
            if (compare) onCompare();
            else void host.admit(guest.key);
          }}
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
        onClick={onRefuse}
      >
        <IconX size={16} />
      </button>
    </>
  );
}

export function GuestRow({
  host,
  guest,
  canCompare = true,
  onCompare,
  onRefuse,
}: {
  host: LiveHost;
  guest: Guest;
  canCompare?: boolean;
  onCompare?: () => void;
  onRefuse?: () => void;
}) {
  const mark = GUEST_MARK[guest.state];
  const row = useRef<HTMLDivElement>(null);
  // Let in leaves the reply code to hand back; turning away or removing
  // leaves the field the next request is pasted into.
  useLandOnChange(guest.state, () =>
    guest.state === "replied"
      ? row.current?.querySelector('[aria-label^="Copy the reply code"]')
      : document.getElementById("live-request"),
  );
  return (
    <div className="vault-row" ref={row}>
      <div className="vault-row__body">
        <GuestMeta guest={guest} />
        <GuestMarks guest={guest} mark={mark} canCompare={canCompare} />
      </div>
      {seatOpen(guest.state) ? (
        <GuestActions
          host={host}
          guest={guest}
          canCompare={canCompare}
          onCompare={onCompare ?? (() => void host.admit(guest.key))}
          onRefuse={onRefuse ?? (() => host.refuse(guest.key))}
        />
      ) : null}
    </div>
  );
}

function seatOpen(state: Guest["state"]): boolean {
  return state === "asking" || state === "replied" || state === "joined";
}

function GuestMeta({ guest }: { guest: Guest }) {
  return (
    <span className="vault-row__text">
      <span className="vault-row__name">{guest.name}</span>
      {guest.kind === "device" ? (
        <span className="vault-row__meta">A device</span>
      ) : null}
      {guest.note ? (
        <span className="vault-row__meta">{guest.note}</span>
      ) : null}
      {guest.connection ? (
        <span
          className="vault-row__meta"
          data-testid="live-owner-connection"
        >
          {guest.connection.detail}
        </span>
      ) : null}
      {guest.sas ? (
        <span className="vault-row__meta live-sas">{guest.sas}</span>
      ) : null}
      {showKeyId(guest) ? (
        <span className="vault-row__meta">{guest.keyId}</span>
      ) : null}
    </span>
  );
}

function showKeyId(guest: Guest): boolean {
  return Boolean(guest.keyId && (guest.nameClash || guest.sas));
}

function GuestMarks({
  guest,
  mark,
  canCompare,
}: {
  guest: Guest;
  mark: Standing;
  canCompare: boolean;
}) {
  return (
    <>
      <StatusMark tone={mark.tone} label={mark.label} />
      {guest.unverified ? <StatusMark tone="warn" label="Unverified" /> : null}
      {guest.nameClash ? (
        <StatusMark tone="warn" label="Same display name" />
      ) : null}
      {waitingMark(guest, canCompare) ? (
        <StatusMark tone="idle" label="Waiting to compare" />
      ) : null}
    </>
  );
}

function waitingMark(guest: Guest, canCompare: boolean): boolean {
  return Boolean(guest.sas && askingWait(guest, canCompare));
}

function askingWait(guest: Guest, canCompare: boolean): boolean {
  return guest.state === "asking" && !canCompare;
}

export function GuestRows({
  host,
  guests,
}: {
  host: LiveHost;
  guests: readonly Guest[];
}) {
  const gate = useJoinGate(host);
  const oldest = oldestAsking(guests);
  return (
    <>
      {guests.map((guest) => (
        <GuestRow
          key={guest.key}
          host={host}
          guest={guest}
          canCompare={!guest.sas || guest.key === oldest}
          onCompare={() => void compareGuest(gate, host, guest)}
          onRefuse={() => refuseGuest(gate, host, guest)}
        />
      ))}
    </>
  );
}

function useJoinGate(host: LiveHost) {
  const held = useRef<{
    host: LiveHost;
    gate: ReturnType<typeof createLivePeerJoinApproval>;
  } | null>(null);
  if (held.current !== null && held.current.host === host) {
    return held.current.gate;
  }
  const gate = createLivePeerJoinApproval();
  held.current = { host, gate };
  return gate;
}

function oldestAsking(guests: readonly Guest[]): string | null {
  let oldest: Guest | null = null;
  for (const guest of guests) {
    if (guest.state !== "asking" || !guest.sas) continue;
    if (!oldest || guest.askedAt < oldest.askedAt) oldest = guest;
  }
  return oldest ? oldest.key : null;
}

async function compareGuest(
  gate: ReturnType<typeof createLivePeerJoinApproval>,
  host: LiveHost,
  guest: Guest,
): Promise<void> {
  const pending = gate.requestJoinApproval(guest.key);
  if (pending.requestId) gate.queue.approve(pending.requestId, guest.key);
  await host.admit(guest.key);
  const seated = host.state.guests.find((row) => row.key === guest.key);
  if (!seated || (seated.state !== "replied" && seated.state !== "joined")) {
    return;
  }
  if (!guest.peerFingerprint) return;
  await rememberTrustedPeer({
    fingerprint: guest.peerFingerprint,
    epoch: guest.peerEpoch ?? 1,
  }).catch(() => undefined);
}

function refuseGuest(
  gate: ReturnType<typeof createLivePeerJoinApproval>,
  host: LiveHost,
  guest: Guest,
): void {
  if (guest.sas) {
    const pending = gate.requestJoinApproval(guest.key);
    if (pending.requestId) gate.queue.deny(pending.requestId, guest.key);
  }
  host.refuse(guest.key);
}
