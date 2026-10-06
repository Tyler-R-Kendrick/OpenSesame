/**
 * Packs that need another (ADR 0179). An account is opened by its credentials,
 * so switching Accounts on switches Password on with it, and Password cannot be
 * switched off while Accounts is on.
 */
import { packEntry } from "@opensesame/vault-item-types";

const REQUIRES = { account: ["password"] } satisfies Record<
  string,
  readonly string[]
>;

/** The packs `id` cannot work without. */
export function packsNeeded(id: string): readonly string[] {
  return Object.entries(REQUIRES).find(([pack]) => pack === id)?.[1] ?? [];
}

/** The packs that name `id` as something they need. */
export function packsNeeding(id: string): readonly string[] {
  return Object.entries(REQUIRES)
    .filter(([, needs]) => needs.includes(id))
    .map(([pack]) => pack);
}

/** The title of the first pack in `on` that needs `id`, or null. */
export function neededBy(
  id: string,
  on: (pack: string) => boolean,
): string | null {
  const pack = packsNeeding(id).find(on);
  return pack === undefined ? null : (packEntry(pack)?.title ?? pack);
}
