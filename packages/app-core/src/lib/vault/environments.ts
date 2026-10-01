/**
 * Named environments for one vault (`vault.environments`).
 *
 * The capability is optional and off until a plan approves it and the vault
 * is enabled. Marking an item required and switching the active environment
 * both refuse until then, and a refusal stores nothing. The schema text is
 * returned to the caller; this module never writes a file.
 */

import { dismissNotice, setStatusNotice } from "../notices.js";

export const ENVIRONMENTS_CAPABILITY = "vault.environments";

export const ENVIRONMENT_NOTICE_ID = `${ENVIRONMENTS_CAPABILITY}.missing`;

export type EnvironmentPlan = Readonly<{
  approvedCapabilities: readonly string[];
}> | null;

export type EnvironmentItem = Readonly<{ id: string; key: string }>;

export type EnvironmentResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "disabled" }>;

type Bag = Record<string, Record<string, string>>;
type Flags = Record<string, Record<string, boolean>>;

export type EnvironmentSnapshot = Readonly<{
  enabled: boolean;
  active: string | null;
  names: readonly string[];
  values: Bag;
  required: Flags;
}>;

const EMPTY: EnvironmentSnapshot = {
  enabled: false,
  active: null,
  names: [],
  values: {},
  required: {},
};

const records = new Map<string, EnvironmentSnapshot>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeVaultEnvironments(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetVaultEnvironments(): void {
  records.clear();
  emit();
}

export function environmentSnapshot(vaultId: string): EnvironmentSnapshot {
  return records.get(vaultId) ?? EMPTY;
}

function approved(plan: EnvironmentPlan): boolean {
  return plan?.approvedCapabilities.includes(ENVIRONMENTS_CAPABILITY) === true;
}

export function vaultEnvironmentsEnabled(
  plan: EnvironmentPlan,
  vaultId: string,
): boolean {
  return approved(plan) && environmentSnapshot(vaultId).enabled;
}

function commit(vaultId: string, next: EnvironmentSnapshot): void {
  records.set(vaultId, next);
  emit();
}

/**
 * Turn environments on for one vault. Refuses while the capability is off.
 * When the vault's items are passed, the `.env.schema` is generated too.
 */
export function enableVaultEnvironments(
  plan: EnvironmentPlan,
  vaultId: string,
  items?: readonly EnvironmentItem[],
): boolean {
  if (!approved(plan)) return false;
  const current = environmentSnapshot(vaultId);
  if (!current.enabled) commit(vaultId, { ...current, enabled: true });
  if (items) renderEnvSchema(plan, vaultId, items);
  return true;
}

function gate(
  plan: EnvironmentPlan,
  vaultId: string,
): EnvironmentSnapshot | null {
  if (!vaultEnvironmentsEnabled(plan, vaultId)) return null;
  return environmentSnapshot(vaultId);
}

const disabled = (): EnvironmentResult => ({ ok: false, reason: "disabled" });

/** Select a named environment, creating it the first time it is chosen. */
export function switchEnvironment(
  plan: EnvironmentPlan,
  vaultId: string,
  name: string,
): EnvironmentResult {
  const state = gate(plan, vaultId);
  const environment = name.trim();
  if (!state || environment.length === 0) return disabled();
  const names = state.names.includes(environment)
    ? state.names
    : [...state.names, environment];
  commit(vaultId, { ...state, names, active: environment });
  return { ok: true };
}

export function activeEnvironment(
  plan: EnvironmentPlan,
  vaultId: string,
): string | null {
  return gate(plan, vaultId)?.active ?? null;
}

function writeCell(
  plan: EnvironmentPlan,
  vaultId: string,
  environment: string,
  itemId: string,
  key: "values" | "required",
  value: string | boolean,
): EnvironmentResult {
  const state = gate(plan, vaultId);
  if (!state || !state.names.includes(environment)) return disabled();
  const column = state[key];
  commit(vaultId, {
    ...state,
    [key]: {
      ...column,
      [environment]: { ...column[environment], [itemId]: value },
    },
  });
  return { ok: true };
}

export function assignEnvironmentValue(
  plan: EnvironmentPlan,
  vaultId: string,
  environment: string,
  itemId: string,
  value: string,
): EnvironmentResult {
  return writeCell(plan, vaultId, environment, itemId, "values", value);
}

/** The value stored for one item in one environment, or null while off. */
export function readEnvironmentValue(
  plan: EnvironmentPlan,
  vaultId: string,
  environment: string,
  itemId: string,
): string | null {
  const state = gate(plan, vaultId);
  if (!state) return null;
  return state.values[environment]?.[itemId] ?? "";
}

export function markEnvironmentRequired(
  plan: EnvironmentPlan,
  vaultId: string,
  environment: string,
  itemId: string,
  required: boolean,
): EnvironmentResult {
  return writeCell(plan, vaultId, environment, itemId, "required", required);
}

export function environmentRequires(
  plan: EnvironmentPlan,
  vaultId: string,
  environment: string,
  itemId: string,
): boolean {
  const state = gate(plan, vaultId);
  if (!state) return false;
  return state.required[environment]?.[itemId] === true;
}

/** `.env.schema` text for the active environment. Null while the feature is off. */
export function renderEnvSchema(
  plan: EnvironmentPlan,
  vaultId: string,
  items: readonly EnvironmentItem[],
): string | null {
  const state = gate(plan, vaultId);
  if (!state) return null;
  const required = state.required[state.active ?? ""];
  return items
    .map(
      (item) =>
        `# @type=string${required?.[item.id] ? "\n# @required" : ""}\n${item.key}=`,
    )
    .join("\n\n");
}

function missingKeys(
  state: EnvironmentSnapshot,
  items: readonly EnvironmentItem[],
): string[] {
  const active = state.active;
  if (active === null) return [];
  return items
    .filter((item) => {
      const required = state.required[active]?.[item.id] === true;
      const value = state.values[active]?.[item.id] ?? "";
      return required && value.length === 0;
    })
    .map((item) => item.key);
}

/**
 * One notice when the active environment has a required item with no value.
 * A filled value or an unmarked item leaves the tray clear of this notice.
 */
export function notifyMissingEnvironmentValues(
  plan: EnvironmentPlan,
  vaultId: string,
  items: readonly EnvironmentItem[],
): void {
  const state = gate(plan, vaultId);
  const missing = state === null ? [] : missingKeys(state, items);
  if (missing.length === 0) {
    dismissNotice(ENVIRONMENT_NOTICE_ID);
    return;
  }
  setStatusNotice({
    id: ENVIRONMENT_NOTICE_ID,
    tone: "warn",
    title: "Environment",
    body: missing.join(", "),
  });
}

/** An env-spec key derived from a vault item's name. */
export function environmentKey(name: string): string {
  const cleaned = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned === "") return "";
  return /^\d/.test(cleaned) ? `_${cleaned}` : cleaned;
}
