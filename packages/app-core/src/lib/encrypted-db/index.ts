/**
 * Searchable encryption over IndexedDB (ADR 0173). The opt-in capability
 * `storage.encrypted-search` installs this for the stores that keep
 * identifiers and names; the library itself reads no setting.
 */

export { defineSchema } from "./schema.js";
export type {
  ColumnSpec,
  EdbRow,
  EdbValue,
  Layer,
  OrderSpec,
  Schema,
  SchemaSpec,
  TableSpec,
} from "./schema.js";
export {
  EncryptedDbUnavailable,
  openEncryptedDb,
} from "./db.js";
export type { EncryptedDb, LayerReport } from "./db.js";
export { EdbQueryError } from "./query.js";
export type { FindOptions, Predicate, Where } from "./query.js";
