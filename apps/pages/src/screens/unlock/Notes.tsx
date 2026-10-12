/** The two standing notes on the unlock form: storage that will not last, and a lockout. */

/** A browser that keeps nothing across tabs. Said once, on the form, because it changes what is safe to store. */
export function DurabilityNote({ durable }: { durable: boolean }) {
  if (durable) return null;
  return (
    <output className="note note--warn">
      <span>
        This browser gives this app no persistent storage, so the vault will be
        gone when the tab closes — private windows and some embedded browsers do
        this. Do not put your only copy of anything in here.
      </span>
    </output>
  );
}

/** Too many wrong tries: how long until the next. */
export function LockoutNote({
  lockedFor,
  failedAttempts,
}: {
  lockedFor: number;
  failedAttempts: number;
}) {
  if (lockedFor <= 0) return null;
  return (
    <output className="note note--warn">
      <span>
        {failedAttempts} failed attempts. Try again in {lockedFor}s.
      </span>
    </output>
  );
}
