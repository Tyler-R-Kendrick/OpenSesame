export type QuorumTypeRow = {
  id: string;
  version: string;
  /** The definition as authored. */
  text: string;
};

/** The types the capability embeds, in install order. */
export const QUORUM_TYPE_IDS: readonly string[];

/** The generated module's text for the marketplace files (read from disk by default). */
export function renderModule(types?: readonly QuorumTypeRow[]): string;
