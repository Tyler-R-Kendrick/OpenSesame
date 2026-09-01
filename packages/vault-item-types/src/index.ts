/**
 * Vault item types (ADR 0087).
 *
 * A vault item type is a manifest, not a code path. This package holds the
 * closed field-type catalogue, the one parser, the runtime registry that loads
 * built-in and installed definitions alike, the projection onto the base
 * native secret, and the built-in corpus itself.
 *
 * `crates/vault-item-types` mirrors the parser and the projection for the host
 * plane from the same `definitions/*.json`.
 */

export * from "./catalogue.js";
export * from "./schema.js";
export * from "./validate.js";
export * from "./registry.js";
export * from "./native.js";
export * from "./values.js";
export * from "./builtin.js";
export { BUILTIN_DEFINITION_JSON } from "./definitions.generated.js";
