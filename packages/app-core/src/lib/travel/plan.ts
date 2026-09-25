/**
 * Which vaults travel and which stay home (ADR 0143). Pure.
 *
 * The person names the vaults that are safe to carry; every other sealed
 * vault on the device departs. That is 1Password's "safe for travel" rule
 * read the safe way round: a vault nobody thought about stays home.
 */

export type PlannableVault = Readonly<{
  id: string;
  kind: "personal" | "project" | "guest";
  state: "open" | "locked" | "empty";
}>;

export type TravelPlan = Readonly<{
  /** Sealed vaults that stay on the device. */
  staying: readonly string[];
  /** Sealed vaults that leave it. */
  departing: readonly string[];
}>;

export type TravelPlanRefusal =
  /** A vault that is not on this device was named as safe. */
  | "unknown_vault"
  /** The open vault would leave while its key is in memory. */
  | "open_vault_departs"
  /** Every sealed vault is marked safe — there is nothing to take away. */
  | "nothing_departs";

export type TravelPlanOutcome =
  | { ok: true; plan: TravelPlan }
  | { ok: false; code: TravelPlanRefusal; ids: readonly string[] };

export function planTravel(input: {
  vaults: readonly PlannableVault[];
  /** The vaults marked safe for travel. */
  safe: readonly string[];
}): TravelPlanOutcome {
  // The guest road is a session, not a vault, and a never-sealed vault has
  // nothing in it: neither travels or stays in any sense that matters.
  const sealed = input.vaults.filter(
    (vault) => vault.kind !== "guest" && vault.state !== "empty",
  );
  const known = new Set(sealed.map((vault) => vault.id));
  const unknown = input.safe.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return { ok: false, code: "unknown_vault", ids: unknown };
  }
  const safe = new Set(input.safe);
  const departing = sealed.filter((vault) => !safe.has(vault.id));
  const open = departing.filter((vault) => vault.state === "open");
  if (open.length > 0) {
    return {
      ok: false,
      code: "open_vault_departs",
      ids: open.map((vault) => vault.id),
    };
  }
  if (departing.length === 0) {
    return { ok: false, code: "nothing_departs", ids: [] };
  }
  return {
    ok: true,
    plan: {
      staying: sealed
        .filter((vault) => safe.has(vault.id))
        .map((vault) => vault.id),
      departing: departing.map((vault) => vault.id),
    },
  };
}
