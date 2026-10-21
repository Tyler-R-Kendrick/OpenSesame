/**
 * The first arrival after joining should land in the joiner's own unlocked
 * vault, not on the transport screen. Returning to the session later (from the
 * vault banner or the Live key) must stay on the session screen, so this is a
 * one-shot handoff set by the successful ask.
 */
let pending = false;

export function requestVaultEntry(): void {
  pending = true;
}

export function takeVaultEntry(): boolean {
  if (!pending) return false;
  pending = false;
  return true;
}

export function cancelVaultEntry(): void {
  pending = false;
}
