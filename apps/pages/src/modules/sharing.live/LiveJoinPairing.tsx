/**
 * The joiner's half of pairing (ADR 0150 §3): the request code to send the
 * owner, and the field the owner's reply code is pasted into. Both codes go
 * person to person — a message, a call, a note — or through a carrier the
 * link names (`rendezvous.ts`); pasting always works.
 */

import type { LiveGuest } from "@opensesame/app-core/lib/live/guest.js";
import { useState } from "react";
import {
  CopyButton,
  FieldRow,
  useCopyFeedback,
} from "../../components/FieldRow.js";
import { FieldShell } from "../../components/FieldShell.js";
import { IconArrowRight, IconShare } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";

/** The first few characters, so the person can tell codes apart. */
function glimpse(code: string): string {
  return `${code.slice(0, 20)}…`;
}

export function RequestStep({
  guest,
  code,
}: {
  guest: LiveGuest;
  code: string;
}) {
  const { copied, failed, copy } = useCopyFeedback();
  const [reply, setReply] = useState("");
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);

  async function connect(): Promise<void> {
    setBusy(true);
    try {
      setWrong(!(await guest.accept(reply)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <FieldRow
        label="Your request code"
        actions={
          <CopyButton
            value={code}
            label="your request code"
            fieldKey="live-request"
            copied={copied}
            failed={failed}
            onCopy={copy}
          />
        }
      >
        <span className="frow__value frow__value--mono">{glimpse(code)}</span>
      </FieldRow>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <FieldShell
          id="live-reply"
          label="The owner's reply code"
          mono
          autoComplete="off"
          lead={<IconShare size={17} />}
          value={reply}
          disabled={busy}
          status={
            wrong ? (
              <StatusMark
                tone="err"
                label="That reply is not for this request"
              />
            ) : null
          }
          onValueChange={(next) => {
            setReply(next);
            setWrong(false);
          }}
          tail={
            <button
              type="submit"
              className="icon-btn"
              aria-label="Connect"
              title="Connect"
              disabled={busy || reply.trim().length === 0}
            >
              <IconArrowRight size={16} />
            </button>
          }
        />
      </form>
    </>
  );
}
