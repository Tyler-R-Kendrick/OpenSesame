/**
 * How a document passes from one person to another in Settings › Trusted
 * contacts (ADR 0186 §10). Nothing here is a network: a packet is one line of
 * text a person copies, hands on over a road they already trust, and pastes
 * into the next person's page.
 *
 * - `PacketOut` shows a packet and copies it. A packet is public by
 *   construction (invitations, signed policies, sealed shares, approvals), so
 *   the ordinary Copy key is right; a secret key or a recovered value is never
 *   handed to this component.
 * - `PacketIn` is the paste field. It says at once what was pasted and
 *   whether this field takes it; a person presses its key to act. A paste is
 *   never acted on by arriving.
 * - `FileIn` and `downloadFile` carry what is too large to be a packet, such
 *   as the recovery file, which holds the protected payload.
 */

import { DeskError } from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  type Packet,
  PacketError,
  type PacketKind,
  decodePacket,
} from "@opensesame/app-core/lib/quorum/packets.js";
import { isString } from "@opensesame/os-domain";
import { type ReactNode, useMemo, useRef, useState } from "react";
import {
  CopyButton,
  FieldRow,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import { IconKey } from "../../components/IconKey.js";
import { IconArrowRight, IconUpload } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import { downloadOnce } from "../../sections/settings/download-once.js";
import {
  GENERIC_FAILURE,
  sentence,
  useCeremonyFailure,
} from "./failure-text.js";

/** A packet is at most 128 KiB decoded, a third more as text, plus the wrapping a mail client adds. */
export const PACKET_TEXT_MAX = 256 * 1024;
/** A recovery file carries a whole vault's chosen items: generous, and still a cap. */
export const FILE_MAX_BYTES = 16 * 1024 * 1024;

/** The packet's head and its check, so two can be told apart and compared by voice. */
export function glimpse(packet: string): string {
  const text = packet.replace(/\s+/g, "");
  return text.length <= 34 ? text : `${text.slice(0, 26)}…${text.slice(-6)}`;
}

export function PacketOut({
  label,
  packet,
  copyLabel,
}: {
  /** The row's label: what this packet is ("Invitation"). */
  label: string;
  packet: string;
  /** The Copy key's object when it reads better than the label ("the invitation"). */
  copyLabel?: string;
}) {
  const { copied, failed, copy } = useCopyFeedback();
  return (
    <FieldRow
      label={label}
      actions={
        <CopyButton
          value={packet}
          label={copyLabel ?? label}
          fieldKey={`packet:${label}`}
          copied={copied}
          failed={failed}
          onCopy={copy}
        />
      }
    >
      <span className="frow__value frow__value--mono tc-packet">
        {glimpse(packet)}
      </span>
    </FieldRow>
  );
}

/** What a kind is called in a sentence: a list of approvals is a list, not an approval. */
function article(kind: string): string {
  const name = kind === "approvals" ? "approvals list" : kind;
  return /^[aeiou]/.test(name) ? `an ${name}` : `a ${name}`;
}

/** "a request", "a welcome or a receipt", "an approval, an approvals list or a release". */
function oneOf(kinds: readonly string[]): string {
  const phrases = kinds.map(article);
  const last = phrases.at(-1) ?? "";
  return phrases.length < 2
    ? last
    : `${phrases.slice(0, -1).join(", ")} or ${last}`;
}

type Reading =
  | Readonly<{ state: "empty" }>
  | Readonly<{ state: "bad"; problem: string }>
  | Readonly<{ state: "ok"; packet: Packet }>;

const EMPTY: Reading = { state: "empty" };

/** What a paste is, against the kinds this field takes (comma-separated). */
function read(text: string, wanted: string): Reading {
  if (text.trim() === "") return EMPTY;
  try {
    const packet = decodePacket(text);
    const kinds = wanted.split(",");
    if (kinds.includes(packet.kind)) return { state: "ok", packet };
    return {
      state: "bad",
      problem: sentence(`this is ${article(packet.kind)}, not ${oneOf(kinds)}`),
    };
  } catch (caught) {
    return {
      state: "bad",
      problem:
        caught instanceof PacketError
          ? sentence(caught.message)
          : GENERIC_FAILURE,
    };
  }
}

export type PacketInProps = Readonly<{
  /** The textarea's id; its key is `<id>-commit`. */
  id: string;
  /** What is pasted here ("A contact's enrollment"). */
  label: string;
  /** The kind this field takes, or the kinds it takes. */
  kind: PacketKind | PacketKind[];
  /** The commit key's sentence ("Add this contact"): its name and tooltip. */
  commitLabel: string;
  /** The commit key's glyph; an arrow by default. */
  icon?: ReactNode;
  /** The pasted text, once a person presses the key. A throw is shown, not swallowed. */
  onPacket: (text: string) => Promise<void>;
  /** A fact about a valid paste, derived from the packet itself, shown before the key is pressed. */
  describe?: (packet: Packet) => string | null;
  /** The tray notice's id and title for a failed step; defaults to this field's. */
  failureId?: string;
  failureTitle?: string;
  disabled?: boolean;
}>;

/** What the field makes of its text: the reading, the mark's sentence and the fact about a good paste. */
function useReading(
  text: string,
  kind: PacketKind | PacketKind[],
  describe: PacketInProps["describe"],
) {
  const wanted = Array.isArray(kind) ? kind.join(",") : kind;
  const reading = useMemo(() => read(text, wanted), [text, wanted]);
  return {
    ok: reading.state === "ok",
    problem: reading.state === "bad" ? reading.problem : "",
    fact: reading.state === "ok" ? (describe?.(reading.packet) ?? "") : "",
  };
}

/** The key that acts on the paste. Not switched off while busy: a press then is ignored, and focus is not dropped. */
function CommitKey({
  id,
  label,
  icon,
  off,
  busy,
  onCommit,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  off: boolean;
  busy: boolean;
  onCommit: () => void;
}) {
  return (
    <div className="actions">
      <IconKey
        id={id}
        label={label}
        disabled={off}
        aria-busy={busy || undefined}
        onClick={onCommit}
      >
        {icon}
      </IconKey>
    </div>
  );
}

/**
 * A labelled paste field with the key that acts on it. Live validation is a
 * mark on the field and no notice: a half-typed packet is not a failure. The
 * step failing is, and that goes to the tray as well.
 */
export function PacketIn({
  id,
  label,
  kind,
  commitLabel,
  icon,
  onPacket,
  describe,
  failureId,
  failureTitle,
  disabled = false,
}: PacketInProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const failure = useCeremonyFailure(
    failureId ?? `trusted-contacts:${id}`,
    failureTitle ?? label,
  );
  const box = useRef<HTMLTextAreaElement>(null);
  const { ok, problem, fact } = useReading(text, kind, describe);
  const shown = problem || failure.message;

  async function commit(): Promise<void> {
    if (busy || !ok) return;
    setBusy(true);
    const done = await failure.run(() => onPacket(text));
    setBusy(false);
    if (!done.ok) return;
    setText("");
    // The key that was pressed is disabled with the field emptied: the
    // keyboard goes back to the field, ready for the next packet, unless the
    // person has already moved on.
    const held = document.activeElement;
    if (held === document.body || held?.id === `${id}-commit`) {
      box.current?.focus();
    }
  }

  return (
    <div className="tc-packet-in">
      <div className="keyed-field">
        <div className="f__labelrow">
          <label className="f__label" htmlFor={id}>
            {label}
          </label>
          {shown ? <StatusMark tone="err" label={shown} /> : null}
        </div>
        <textarea
          ref={box}
          id={id}
          value={text}
          rows={3}
          maxLength={PACKET_TEXT_MAX}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={disabled}
          aria-invalid={shown ? true : undefined}
          onChange={(event) => {
            setText(event.target.value);
            failure.clear();
          }}
        />
        <CommitKey
          id={`${id}-commit`}
          label={commitLabel}
          icon={icon ?? <IconArrowRight size={17} />}
          off={disabled || !ok}
          busy={busy}
          onCommit={() => void commit()}
        />
      </div>
      {fact ? <span className="tc-fact">{fact}</span> : null}
    </div>
  );
}

/** A file's text, read as UTF-8 by the browser's own reader. */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(isString(reader.result) ? reader.result : "");
    reader.onerror = () =>
      reject(new DeskError("file_read", "that file could not be read"));
    reader.readAsText(file);
  });
}

/** The text of a chosen file, or the sentence for why it is not taken. */
async function textOf(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) {
    throw new DeskError("file_size", "that file is too large");
  }
  const text = await readText(file);
  if (text.includes("\u0000")) {
    throw new DeskError("file_type", "that file is not text");
  }
  return text;
}

export type FileInProps = Readonly<{
  /** The picker key's id. */
  id: string;
  /** The key's sentence ("Choose the recovery file"). */
  label: string;
  accept?: string;
  maxBytes?: number;
  /** The file's text and name, once chosen. Nothing is read until a person picks. */
  onText: (text: string, name: string) => Promise<void>;
  failureId?: string;
  failureTitle?: string;
}>;

/**
 * The OS file picker behind one icon key. A chosen file is hostile input: its
 * size is capped before it is read, and only text is taken; the step that
 * parses it is the caller's.
 */
export function FileIn({
  id,
  label,
  accept = ".json,application/json",
  maxBytes = FILE_MAX_BYTES,
  onText,
  failureId,
  failureTitle,
}: FileInProps) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const failure = useCeremonyFailure(
    failureId ?? `trusted-contacts:${id}`,
    failureTitle ?? label,
  );

  async function take(file: File): Promise<void> {
    setBusy(true);
    await failure.run(async () =>
      onText(await textOf(file, maxBytes), file.name),
    );
    setBusy(false);
  }

  return (
    <div className="actions">
      <IconKey
        id={id}
        label={label}
        aria-busy={busy || undefined}
        onClick={() => input.current?.click()}
      >
        <IconUpload size={17} />
      </IconKey>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="visually-hidden"
        tabIndex={-1}
        aria-label={label}
        onChange={(event) => {
          const picked = event.target.files?.[0];
          // Cleared so the same file can be picked again after a refusal.
          event.target.value = "";
          if (picked && !busy) void take(picked);
        }}
      />
      {failure.message ? (
        <StatusMark tone="err" label={failure.message} />
      ) : null}
    </div>
  );
}

/** A file name safe to hand a browser: letters, digits, dot, dash, underscore. */
export function fileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return safe === "" ? "circle" : safe;
}

/** Hand the person a file the page keeps no copy of: it may be the only one. */
export function downloadFile(name: string, body: string): void {
  downloadOnce(fileName(name), body);
}
