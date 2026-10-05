/**
 * What a device duress code can do, as data (ADR 0155).
 *
 * A mode is a row, not a branch: the Settings sheet draws its choices, its
 * "Opens" fact and its consent sentence from the registry, and arming maps the
 * mode to the one string sealed with the code. A mode may only be added if
 * unlock really does what its `opens` sentence says; the sheet never offers a
 * mode that promises more than unlock performs, and a consent sentence is
 * ticked for one mode and never carried to another.
 */

/**
 * What unlock reads out of the sealed slot. Existing enrollments hold exactly
 * these two strings, so the storage format and the unlock behaviour they drive
 * do not change when a mode is added or renamed.
 */
export type DuressPresentation = "decoy" | "locked";

/**
 * Work a mode runs beyond showing a presentation. A name here is a promise
 * that `effects.ts` has a runner for it and that the unlock path runs it, so a
 * mode lands together with its runner or not at all.
 */
export type DuressEffectName = "decoy_items" | "freeze" | "wipe";

/** One choice among a few the owner picks for a mode. */
export type DuressInputOption = Readonly<{ value: string; label: string }>;

/**
 * An extra thing the owner supplies for a mode. Every kind reaches
 * `enableDuressCode`'s `extras` as a string under `id`: text as typed, a choice
 * as its option's value, items as one per line, a confirmation as the word typed.
 */
export type DuressModeInput =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "text"; id: string; label: string }>
  | Readonly<{
      kind: "choice";
      id: string;
      label: string;
      options: readonly DuressInputOption[];
    }>
  | Readonly<{
      kind: "items";
      id: string;
      label: string;
      min: number;
      max: number;
      /** Longest a single line may be. */
      maxLength: number;
      /**
       * Lines the sheet offers when the mode is picked, so the owner edits a
       * plausible list rather than facing a blank box. Authored with the mode,
       * never read from the vault.
       */
      starter?: readonly string[];
    }>
  | Readonly<{
      kind: "confirm";
      id: string;
      label: string;
      /** The word that must be typed, compared without case or padding. */
      word: string;
    }>;

/** What a mode asks the unlock path to do once its code matches. */
export type DuressPlan = Readonly<{
  effect: DuressEffectName;
  /** The effect's own parameters; its runner validates them. */
  body: unknown;
}>;

export type DuressMode<Id extends string = string> = Readonly<{
  id: Id;
  /** The choice's name, on a radio. */
  label: string;
  /** One line: what typing the code does. */
  opens: string;
  /** What the owner ticks for this mode, and for no other. */
  consent: string;
  /** The string sealed with the code, read at unlock. */
  presentation: DuressPresentation;
  input: DuressModeInput;
  /**
   * Builds what is sealed with the code from the owner's inputs. A mode with an
   * effect has one; the plan reaches the unlock path only through the slot.
   */
  plan?: (extras: Readonly<Record<string, string>>) => DuressPlan;
}>;
