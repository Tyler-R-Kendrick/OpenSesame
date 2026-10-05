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
 * Work a mode runs beyond showing a presentation. Reserved: no mode has one,
 * and the unlock path runs none, so the type admits no value until a mode that
 * unlock can honour lands and widens it.
 */
export type DuressEffectName = never;

/** An extra thing the owner supplies for a mode; `none` for every mode today. */
export type DuressModeInput =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "text";
      /** Key under which the value reaches `enableDuressCode`'s `extras`. */
      id: string;
      label: string;
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
  effect?: DuressEffectName;
}>;
