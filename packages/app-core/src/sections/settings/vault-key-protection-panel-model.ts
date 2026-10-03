/**
 * The actions `VaultKeyProtectionPanel` drives (ADR 0133 §8): the pure part of
 * that screen — no React, no DOM — so any shell can supply the same set. A
 * shell that cannot supply all five has nothing to draw: the panel is absent,
 * not a row of disabled keys.
 */
export type VaultKeyProtectionActions = {
  onAdd: () => void;
  onTest: (protectorId: string) => void;
  onPreferred: (protectorId: string) => void;
  onRemove: (protectorId: string) => void;
  onRotateCompromised: () => void;
};
