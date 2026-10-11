/**
 * Giving up on a recovery removes the key this device made for it, and with
 * it everything the recovery has gathered: the one act in this panel that
 * cannot be taken back. One press arms the key; a second fires it. A keep
 * beside it, while armed, disarms and hands the keyboard back to the key.
 */

import { useRef, useState } from "react";
import { IconKey } from "../../../components/IconKey.js";
import { IconTrash, IconX } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import { useFocusAfter } from "../../../lib/use-focus-after.js";

export function GiveUpKey({
  busy,
  failure,
  onGiveUp,
}: {
  busy: boolean;
  /** The sentence for why the last try did not end it; empty otherwise. */
  failure: string;
  onGiveUp: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  // A refused try leaves the key disabled for a moment, which drops the keyboard.
  const land = useFocusAfter(busy);
  const press = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    onGiveUp();
    land(() => primary.current);
  };
  return (
    <div className="actions">
      <IconKey
        id="recovery-give-up"
        keyRef={primary}
        label={
          armed
            ? "Give up on this recovery for good"
            : "Give up on this recovery"
        }
        small
        armed={armed}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={press}
      >
        <IconTrash size={16} />
      </IconKey>
      {armed ? (
        <IconKey
          id="recovery-keep"
          label="Keep this recovery"
          small
          disabled={busy}
          onClick={() => {
            setArmed(false);
            primary.current?.focus();
          }}
        >
          <IconX size={16} />
        </IconKey>
      ) : null}
      {failure ? <StatusMark tone="err" label={failure} /> : null}
    </div>
  );
}
