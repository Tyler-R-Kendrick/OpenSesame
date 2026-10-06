/**
 * What an encrypted database may be asked, declared up front (ADR 0175).
 *
 * The schema lives in the application's code and never on disk. It says, per
 * column, which searchable layers the column may reach; the layer itself is
 * only materialised when a query first needs it (the onion's peel, run in
 * the direction a client-side store can run it), unless the column says
 * `eager`. A column with no layers is stored sealed and is found only by its
 * row's key.
 *
 * - `eq`: blind equality tokens. A column that names a `group` shares its
 *   tokens with every column in the group, so an id can be found across
 *   tables (CryptDB's join layer).
 * - `order`: order-preserving keys over integers or times (`ope.ts`).
 * - `keyword`: whole-word tokens, and word-prefix tokens when `prefix` is a
 *   minimum length.
 */

import type { JsonObject, JsonValue } from "@opensesame/os-domain";
import { OPE_MAX_DOMAIN_BITS } from "./ope.js";

export type EdbValue = JsonValue;
export type EdbRow = JsonObject;

export type OrderSpec =
  | Readonly<{ type: "int"; min: number; max: number }>
  | Readonly<{ type: "time" }>;

export type ColumnSpec = Readonly<{
  eq?: true | Readonly<{ group: string }>;
  order?: OrderSpec;
  keyword?: true | Readonly<{ prefix: number }>;
  /** Build the layers at open rather than at the first query that needs them. */
  eager?: true;
}>;

export type TableSpec = Readonly<{
  /** The row field that holds the primary key: a non-empty string. */
  key: string;
  columns?: Readonly<Record<string, ColumnSpec>>;
}>;

export type SchemaSpec = Readonly<Record<string, TableSpec>>;

export type Layer = "eq" | "order" | "keyword";

/** A layer of one column, resolved to what the database needs to run it. */
export type LayerPlan = Readonly<{
  table: string;
  column: string;
  layer: Layer;
  /** Names the layer and its settings: a changed spec is a new layer. */
  id: string;
  eager: boolean;
  /** Eq: the scope tokens are minted under. */
  scope: string;
  /** Order: the number of values in the domain, and where it starts. */
  domain: bigint;
  origin: bigint;
  /** Order: whether ISO time strings are values of the column. */
  time: boolean;
  /** Keyword: the shortest prefix that is indexed, or 0 for none. */
  prefix: number;
}>;

/** The default domain of a `time` column: milliseconds from 1970 to 10889. */
export const TIME_DOMAIN: bigint = 1n << BigInt(OPE_MAX_DOMAIN_BITS);

/** The longest word prefix that is indexed. */
export const PREFIX_MAX = 12;

export type Schema = Readonly<{
  tables: ReadonlySet<string>;
  keyOf: (table: string) => string;
  layersOf: (table: string) => readonly LayerPlan[];
  layer: (table: string, column: string, layer: Layer) => LayerPlan | undefined;
  columns: (table: string) => readonly string[];
}>;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`encrypted-db schema: ${message}`);
}

function name(value: string, what: string): void {
  check(
    value.length > 0 && !value.includes("\u0000"),
    `${what} must be a non-empty name without NUL`,
  );
}

function orderDomain(spec: OrderSpec) {
  if (spec.type === "time") return { domain: TIME_DOMAIN, origin: 0n };
  check(
    Number.isSafeInteger(spec.min) && Number.isSafeInteger(spec.max),
    "an int column's bounds are safe integers",
  );
  check(spec.max >= spec.min, "an int column's max is not below its min");
  const domain = BigInt(spec.max) - BigInt(spec.min) + 1n;
  check(
    domain <= TIME_DOMAIN,
    `an int column spans at most 2^${OPE_MAX_DOMAIN_BITS} values`,
  );
  return { domain, origin: BigInt(spec.min) };
}

function plansOf(table: string, column: string, spec: ColumnSpec): LayerPlan[] {
  const eager = spec.eager === true;
  const base = {
    table,
    column,
    eager,
    scope: "",
    domain: 0n,
    origin: 0n,
    time: false,
    prefix: 0,
  };
  const plans: LayerPlan[] = [];
  if (spec.eq !== undefined) {
    const group = spec.eq === true ? undefined : spec.eq.group;
    if (group !== undefined) name(group, `${table}.${column} group`);
    const scope =
      group === undefined ? `c:${table}\u0000${column}` : `g:${group}`;
    plans.push({ ...base, layer: "eq", scope, id: `eq\u0000${scope}` });
  }
  if (spec.order !== undefined) {
    const { domain, origin } = orderDomain(spec.order);
    plans.push({
      ...base,
      layer: "order",
      domain,
      origin,
      time: spec.order.type === "time",
      id: `order\u0000${origin}\u0000${domain}`,
    });
  }
  if (spec.keyword !== undefined) {
    const prefix = spec.keyword === true ? 0 : spec.keyword.prefix;
    check(
      Number.isInteger(prefix) && prefix >= 0 && prefix <= PREFIX_MAX,
      `${table}.${column} prefix is 0 to ${PREFIX_MAX}`,
    );
    plans.push({
      ...base,
      layer: "keyword",
      prefix,
      id: `keyword\u0000${prefix}`,
    });
  }
  return plans;
}

/** Validate and resolve a schema. Throws on a spec that cannot be run. */
export function defineSchema(spec: SchemaSpec): Schema {
  const keys = new Map<string, string>();
  const layers = new Map<string, readonly LayerPlan[]>();
  const columns = new Map<string, readonly string[]>();
  for (const [table, tableSpec] of Object.entries(spec)) {
    name(table, "a table");
    name(tableSpec.key, `${table} key`);
    keys.set(table, tableSpec.key);
    const plans: LayerPlan[] = [];
    const entries = Object.entries(tableSpec.columns ?? {});
    for (const [column, columnSpec] of entries) {
      name(column, `${table} column`);
      check(
        column !== tableSpec.key,
        `${table}.${column} is the key and is found by it`,
      );
      plans.push(...plansOf(table, column, columnSpec));
    }
    layers.set(table, plans);
    columns.set(
      table,
      entries.map(([column]) => column),
    );
  }
  const need = (table: string): string => {
    check(keys.has(table), `no table "${table}"`);
    return table;
  };
  return {
    tables: new Set(keys.keys()),
    keyOf: (table) => keys.get(need(table)) ?? "",
    layersOf: (table) => layers.get(need(table)) ?? [],
    layer: (table, column, layer) =>
      (layers.get(need(table)) ?? []).find(
        (plan) => plan.column === column && plan.layer === layer,
      ),
    columns: (table) => columns.get(need(table)) ?? [],
  };
}
