/**
 * Pick authored tutorial entries by id from a registry partition. The
 * identity partition (`identity-catalog.ts`, `identity-goals.ts`) is shared
 * by four capabilities — local IAM, federation, directory provisioning and
 * SIOP — so each runtime names the ids it owns and contributes exactly those.
 * An id that is not authored is a bug in the runtime: it throws at
 * activation rather than registering nothing.
 */

export function pickById<T extends { readonly id: string }>(
  all: readonly T[],
  ids: readonly string[],
): T[] {
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  return ids.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw new Error(`tutorial entry not authored: ${id}`);
    return entry;
  });
}
