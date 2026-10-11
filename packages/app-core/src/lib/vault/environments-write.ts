/**
 * The one way a surface writes environments (ADR 0188): through the plan.
 *
 * `vault.environments` is optional and off until a plan approves it. A write
 * asked for while it is off is refused and stores nothing, so the feature is
 * absent in the data path, not only in what is drawn. The write itself is one
 * sealed edit the vault store applies (`VaultStore.editEnvironments`).
 */

import type { EnvironmentsEdit } from "./body-environments.js";
import { type EnvironmentPlan, environmentsApproved } from "./environments.js";
import { vaultStore } from "./store.js";

export type EnvironmentResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "disabled" }>;

export async function writeEnvironments(
  plan: EnvironmentPlan,
  edit: EnvironmentsEdit,
): Promise<EnvironmentResult> {
  if (!environmentsApproved(plan)) return { ok: false, reason: "disabled" };
  await vaultStore.editEnvironments(edit);
  return { ok: true };
}

/**
 * Which environment each vault's sheet is looking at in this tab. Not vault
 * data: choosing what to look at is not a write, so it never syncs and never
 * reaches disk, and a new tab starts on the first environment.
 */
const looking = new Map<string, string>();

/** The environment to show: the one chosen here if it still exists, else the first. */
export function environmentInView(
  tomb: string,
  names: readonly string[],
): string | null {
  const chosen = looking.get(tomb);
  return chosen !== undefined && names.includes(chosen)
    ? chosen
    : (names[0] ?? null);
}

export function viewEnvironment(tomb: string, name: string): void {
  looking.set(tomb, name);
}

export function forgetViewedEnvironments(): void {
  looking.clear();
}
