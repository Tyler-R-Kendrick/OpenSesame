import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "./repos/postgres.js";
import * as schema from "./schema/index.js";

/**
 * Pairwise sector keys and who holds them (security finding: legacy
 * non-canonical sector spellings shared a pairwise `sub`).
 *
 * `sectorKeyOf` is `pairwiseSectorKey` from `@opensesame/oauth-provider`
 * (`src/pairwise/sector.ts`), repeated here because this package must not
 * import the issuer. `apps/control-plane`'s sector-key parity test holds the
 * two to one answer; migration 0029 derives the same key in SQL for rows that
 * predate the column.
 */
export function sectorKeyOf(sectorIdentifier: string): string {
  const raw = sectorIdentifier.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return raw;
  if (!url.hostname) return raw;
  return url.pathname === "/" ? url.host : `${url.host}${url.pathname}`;
}

/** Why a client may not mint a pairwise `sub` under its key. */
export type SectorKeyBlock =
  | "cross_owner_collision"
  | "unparsed_legacy_spelling";

/** The owner a claim is held for: the principal, or the client itself. */
export function sectorOwnerKey(client: {
  id: string;
  ownerPrincipalId?: string | undefined;
}): string {
  return client.ownerPrincipalId ?? `client:${client.id}`;
}

/** Another owner already holds this sector key. Maps to 409 `sector_identifier_taken`. */
export class OAuthClientSectorClaimedError extends Error {
  override readonly name = "OAuthClientSectorClaimedError";
  readonly code = "sector_identifier_taken" as const;
  constructor(readonly sectorKey: string) {
    super("another owner already holds a client under this sector key");
  }
}

type ClaimTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const rowOwnerKey = sql`coalesce(${schema.oauthClients.ownerPrincipalId}, 'client:' || ${schema.oauthClients.id})`;

/**
 * Hold `sectorKey` for `ownerKey`, inside the caller's transaction, before the
 * client row that uses it is written.
 *
 * The claim row is the arbiter: `on conflict do nothing` then `for update`
 * makes every writer on one key wait for the one ahead of it, so of two
 * concurrent registrations by different owners exactly one is admitted. A
 * held key passes to another owner only when its holder has no other client on
 * it at all — revoked ones included, since a revoked client's subjects were
 * already seen by its owner. That is what lets an origin client's claim flow
 * move its (single-client) key to the claimant, and nothing else.
 */
export async function claimSectorKey(
  tx: ClaimTx,
  sectorKey: string,
  ownerKey: string,
  clientId: string,
): Promise<void> {
  const claims = schema.oauthClientSectorClaims;
  await tx
    .insert(claims)
    .values({ sectorKey, ownerKey })
    .onConflictDoNothing({ target: claims.sectorKey });
  const [claim] = await tx
    .select()
    .from(claims)
    .where(eq(claims.sectorKey, sectorKey))
    .for("update");
  if (!claim) throw new Error("sector claim vanished inside its transaction");
  if (claim.ownerKey === ownerKey) return;
  const [held] = await tx
    .select({ id: schema.oauthClients.id })
    .from(schema.oauthClients)
    .where(
      and(
        eq(schema.oauthClients.sectorKey, sectorKey),
        ne(schema.oauthClients.id, clientId),
        sql`${rowOwnerKey} = ${claim.ownerKey}`,
      ),
    )
    .limit(1);
  if (held) throw new OAuthClientSectorClaimedError(sectorKey);
  await tx
    .update(claims)
    .set({ ownerKey, updatedAt: new Date() })
    .where(eq(claims.sectorKey, sectorKey));
}
