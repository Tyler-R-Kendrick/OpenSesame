/**
 * A vault with an authenticator code but no passkey, PIN or password: a code can
 * only ever follow a key, so nothing here can open it. Said in the page, as a
 * plain line, rather than drawn as three tabs that all fail. It is guidance for
 * a standing condition with roads out (delete, or continue as a guest), not a
 * failed operation, so it never goes to the tray.
 */
export function NoPrimaryNote() {
  return (
    <p className="hint">
      This vault has an authenticator code but no passkey, PIN or password to
      open it with, so nothing here can unlock it. Delete it and seal it again,
      or continue as a guest.
    </p>
  );
}
