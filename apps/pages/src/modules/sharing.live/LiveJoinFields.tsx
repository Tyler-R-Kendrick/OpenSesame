/** Link, identity, and peer-trust fields for the live join form. */
import type { LiveLink } from "@opensesame/app-core/lib/live/link.js";
import { NAME_MAX, NOTE_MAX } from "@opensesame/app-core/lib/live/messages.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconSecret, IconShare, IconUser } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

type PersonFields = Readonly<{
  needsCode: boolean;
  code: string;
  name: string;
  note: string;
  busy: boolean;
  setCode: (next: string) => void;
  setName: (next: string) => void;
  setNote: (next: string) => void;
}>;

export function LiveLinkField({
  pasted,
  link,
  busy,
  setPasted,
}: {
  pasted: string;
  link: LiveLink | null;
  busy: boolean;
  setPasted: (next: string) => void;
}) {
  return (
    <FieldShell
      id="live-link"
      label="Link"
      type="password"
      mono
      autoComplete="off"
      lead={<IconShare size={17} />}
      value={pasted}
      disabled={busy}
      status={
        pasted && !link ? (
          <StatusMark tone="err" label="Not a live-session link" />
        ) : null
      }
      onValueChange={setPasted}
    />
  );
}

export function JoinPersonFields(props: PersonFields) {
  const { needsCode, code, name, note, busy, setCode, setName, setNote } =
    props;
  return (
    <>
      {needsCode ? (
        <FieldShell
          id="live-code"
          label="Code"
          mono
          autoComplete="off"
          placeholder="XXXX-XXXX"
          lead={<IconSecret size={17} />}
          value={code}
          disabled={busy}
          onValueChange={setCode}
        />
      ) : null}
      <FieldShell
        id="live-name"
        label="Your name"
        autoComplete="nickname"
        lead={<IconUser size={17} />}
        value={name}
        disabled={busy}
        onValueChange={(next) => setName(next.slice(0, NAME_MAX))}
      />
      <FieldShell
        id="live-note"
        label="Note"
        placeholder="Optional"
        value={note}
        disabled={busy}
        onValueChange={(next) => setNote(next.slice(0, NOTE_MAX))}
      />
    </>
  );
}

export function JoinVaultSealFields({
  pin,
  confirm,
  accepted,
  problem,
  busy,
  setPin,
  setConfirm,
  setAccepted,
}: {
  pin: string;
  confirm: string;
  accepted: boolean;
  problem: string | null;
  busy: boolean;
  setPin: (next: string) => void;
  setConfirm: (next: string) => void;
  setAccepted: (next: boolean) => void;
}) {
  return (
    <fieldset className="fieldset">
      <legend>Seal this device</legend>
      <div className="field">
        <label htmlFor="live-device-pin">Device PIN</label>
        <input
          id="live-device-pin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          title="8–12 characters, no repeated character, no sequential digits."
          value={pin}
          disabled={busy}
          onChange={(event) => setPin(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="live-device-pin-confirm">Confirm PIN</label>
        <input
          id="live-device-pin-confirm"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          value={confirm}
          disabled={busy}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
      {problem ? <StatusMark tone="err" label={problem} /> : null}
      <label className="check">
        <input
          type="checkbox"
          checked={accepted}
          disabled={busy}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>I understand this vault cannot be recovered.</span>
      </label>
    </fieldset>
  );
}

export function PeerTrustField({
  peerTrust,
  busy,
  setPeerTrust,
}: {
  peerTrust: string;
  busy: boolean;
  setPeerTrust: (next: string) => void;
}) {
  return (
    <FieldShell
      id="live-peer-trust"
      label="Peer trust signal"
      type="password"
      mono
      autoComplete="off"
      value={peerTrust}
      disabled={busy}
      onValueChange={setPeerTrust}
    />
  );
}
