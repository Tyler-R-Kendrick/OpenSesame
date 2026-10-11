/**
 * Environments in a vault body (ADR 0188).
 *
 * An item is a key in the vault's `.env.schema` exactly when it carries an
 * `environments` object, one cell per environment: the value sealed for that
 * environment, and whether the key is required there. The body carries the
 * list of environment names. Both are sealed with everything else, and neither
 * reaches a subtitle, search text or a file name.
 *
 * This file is the format: the shapes, what a name may be, and how two bodies'
 * lists merge. What a person does with them is `app-core`'s
 * `lib/vault/environments*.ts`.
 */

import { type JsonValue, isJsonObject, isString } from "@opensesame/os-domain";

/** One key's value and rule in one environment. Absent fields are unset. */
export type EnvironmentCell = {
  value?: string;
  required?: boolean;
};

/** Environment name → cell. The item's own copy of the schema's matrix row. */
export type ItemEnvironments = Readonly<Record<string, EnvironmentCell>>;

/**
 * An environment on the body: when it was added, or when it was removed. A
 * removal stays as a marker so a device that has not heard of it cannot bring
 * the name back; the later `at` wins and a tie goes to the removal.
 */
export type EnvironmentRecord = { at: string; removed?: true };

export type VaultEnvironments = Readonly<Record<string, EnvironmentRecord>>;

/**
 * What an environment may be called. The name appears unquoted in the generated
 * schema (`forEnv(staging)`, `enum(dev, staging)`), so it is lower-case words
 * joined by `-`, `_` or `.`, not something a parser has to unescape.
 */
const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** The name a person typed as the name it is stored under, or null if it cannot be one. */
export function normalizeEnvironmentName(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return ENVIRONMENT_NAME.test(name) ? name : null;
}

export function isEnvironmentName(name: string): boolean {
  return ENVIRONMENT_NAME.test(name);
}

/**
 * The live environments, oldest first so a vault's own order (development,
 * staging, production) holds on every device, with the name as the tiebreak.
 * A name that is not a valid one is not listed: the body is sealed, but this
 * never trusts a key to be a name.
 */
export function environmentNames(
  environments: VaultEnvironments | undefined,
): string[] {
  return Object.entries(environments ?? {})
    .filter(([name, record]) => isEnvironmentName(name) && !record.removed)
    .sort(([a, left], [b, right]) =>
      left.at === right.at
        ? a.localeCompare(b)
        : left.at.localeCompare(right.at),
    )
    .map(([name]) => name);
}

/**
 * An item's cells as they arrive from outside the sealed body (a store entry's
 * trailer): only names that are names and fields that are the right type, so
 * a hostile or hand-edited file cannot plant anything else.
 */
export function parseItemEnvironments(
  raw: JsonValue | undefined,
): ItemEnvironments | undefined {
  if (!isJsonObject(raw)) return undefined;
  const out: Record<string, EnvironmentCell> = {};
  for (const [name, cell] of Object.entries(raw)) {
    if (!isEnvironmentName(name) || !isJsonObject(cell)) continue;
    out[name] = {
      ...(isString(cell.value) && cell.value !== ""
        ? { value: cell.value }
        : undefined),
      ...(cell.required === true ? { required: true as const } : undefined),
    };
  }
  return out;
}

/** The cell an item holds for one environment, never an inherited property. */
export function cellOf(
  environments: ItemEnvironments | undefined,
  name: string,
): EnvironmentCell | undefined {
  return environments && Object.hasOwn(environments, name)
    ? environments[name]
    : undefined;
}

function recordOf(
  environments: VaultEnvironments | undefined,
  name: string,
): EnvironmentRecord | undefined {
  return environments && Object.hasOwn(environments, name)
    ? environments[name]
    : undefined;
}

function laterRecord(
  left: EnvironmentRecord | undefined,
  right: EnvironmentRecord | undefined,
): EnvironmentRecord | undefined {
  if (!left || !right) return left ?? right;
  if (left.at !== right.at) return left.at > right.at ? left : right;
  // Same instant: the removal, so either argument order agrees.
  return left.removed ? left : right;
}

/**
 * Two bodies' environment lists, name by name. Deterministic and commutative,
 * and a name removed later than it was added stays removed.
 */
export function mergeEnvironments(
  left: VaultEnvironments | undefined,
  right: VaultEnvironments | undefined,
): VaultEnvironments | undefined {
  const out: Record<string, EnvironmentRecord> = {};
  for (const name of new Set([
    ...Object.keys(left ?? {}),
    ...Object.keys(right ?? {}),
  ])) {
    const record = laterRecord(recordOf(left, name), recordOf(right, name));
    if (record) out[name] = record;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
