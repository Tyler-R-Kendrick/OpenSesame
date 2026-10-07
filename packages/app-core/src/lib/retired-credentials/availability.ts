/** Visibility only: this grants neither enrollment nor production authority. */
export function decoyControlsAvailable(
  state: {
    status: string;
    guest: boolean;
    decoy: boolean;
    awaitingSecondStep: boolean;
  },
  supported: boolean,
  records: { traps: readonly object[]; events: readonly object[] } | null,
): boolean {
  return (
    state.status === "unlocked" &&
    !state.guest &&
    !state.decoy &&
    !state.awaitingSecondStep &&
    (supported ||
      !records ||
      records.traps.length > 0 ||
      records.events.length > 0)
  );
}
