/**
 * The refusal vocabulary (ADR 0087 §5): the codes a definition or an install
 * is turned away with. `crates/vault-item-types/src/errors.rs` spells the same
 * codes, so the two rejection tables compare row for row.
 */

export type DefinitionErrorCode =
  | "too-large"
  | "syntax"
  | "unknown-field"
  | "api-version"
  | "kind"
  | "id"
  | "version"
  | "publisher"
  | "text"
  | "extension"
  | "name"
  | "sections"
  | "field-id"
  | "field-type"
  | "duplicate-field"
  | "options"
  | "multiple"
  | "concealed-default"
  | "native-secret"
  | "trailer"
  | "cxf"
  | "concealed-preview"
  | "handler";

export type DefinitionError = {
  readonly code: DefinitionErrorCode;
  /** Dotted path into the manifest, e.g. `spec.sections[0].fields[2].type`. */
  readonly path: string;
  readonly message: string;
};
