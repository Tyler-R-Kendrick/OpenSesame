export type ResetMailTypeRow = {
  id: string;
  version: string;
  /** The definition as authored. */
  text: string;
};

/** The types the capability embeds, in install order. */
export const RESET_MAIL_TYPE_IDS: readonly string[];

/** The generated module's text for the marketplace file (read from disk by default). */
export function renderModule(types?: readonly ResetMailTypeRow[]): string;
