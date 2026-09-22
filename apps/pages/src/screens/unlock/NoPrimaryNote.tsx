/**
 * A vault with an authenticator code but no passkey, PIN or password: a code can
 * only ever follow a key, so nothing here can open it. Said out loud rather than
 * drawn as three tabs that all fail.
 */
export function NoPrimaryNote() {
  return (
    <output className="note note--err">
      <span>
        This vault has an authenticator code but no passkey, PIN or password to
        open it with, so nothing here can unlock it. Delete it and seal it
        again, or continue as a guest.
      </span>
    </output>
  );
}
