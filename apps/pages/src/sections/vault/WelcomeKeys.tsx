/**
 * The mono line under the welcome buffer: the keys of the list beside it.
 *
 * Two voices, as `EmptyTip`: the keys on a desktop and under a narrow window
 * with a mouse, the finger's own twin (DESIGN.md § Touch) where the primary
 * pointer is coarse. A state with no touch counterpart draws nothing there
 * rather than a key a phone does not have.
 */
export function welcomeKeys(inTrash: boolean, empty: boolean): string {
  if (inTrash) {
    return empty
      ? "r restore · X delete · ? keys"
      : "enter open · r restore · X delete · / search · ? keys";
  }
  return empty
    ? "n new · import · ? keys"
    : "enter open · n new · / search · ? keys";
}

/** What the same list asks of a finger, or null where nothing is to be done. */
export function welcomeTouch(inTrash: boolean, empty: boolean): string | null {
  if (inTrash) return empty ? null : "hold or swipe a row to restore or delete";
  return empty
    ? "tap + to add an item, or import"
    : "hold or swipe a row for actions";
}

export function WelcomeKeys({
  inTrash,
  empty,
}: {
  inTrash: boolean;
  empty: boolean;
}) {
  const keys = welcomeKeys(inTrash, empty);
  const touch = welcomeTouch(inTrash, empty);
  if (touch === null) {
    return <p className="buffer__keys buffer__keys--keys">{keys}</p>;
  }
  return (
    <p className="buffer__keys">
      <span className="buffer__keys-keys">{keys}</span>
      <span className="buffer__keys-touch">{touch}</span>
    </p>
  );
}
