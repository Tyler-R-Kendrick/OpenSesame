/** A login item's website rule: the URI and how it is matched. */
export type UriMatch =
  | "domain"
  | "host"
  | "exact"
  | "never"
  | "wildcard"
  | "regex";
export type LoginUri = {
  /** Stable across edits so rows retain identity. */
  id: string;
  uri: string;
  match: UriMatch;
};
