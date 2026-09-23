/**
 * Shared unlock miss copy and requireDurable default (INV-03).
 */

export const UNLOCK_PIN_MISS = "That PIN did not unlock the vault.";
export const UNLOCK_PASSWORD_MISS = "That password did not unlock the vault.";
export const UNLOCK_PASSKEY_MISS = "That passkey did not unlock the vault.";

export type UnlockDuressGateOptions = Readonly<{
  requireDurable?: boolean;
}>;

export const DEFAULT_UNLOCK_DURESS_GATE_OPTIONS =
  {} satisfies UnlockDuressGateOptions;

export function resolveRequireDurable(
  options: UnlockDuressGateOptions,
): boolean {
  return options.requireDurable ?? true;
}
