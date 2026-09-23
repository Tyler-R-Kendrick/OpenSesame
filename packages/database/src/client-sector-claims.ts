import { and, eq, isNull, ne, sql } from "drizzle-orm";
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
  | "unparsed_legacy_spelling"
  | "sector_released";

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
 * client row that uses it is written, and answer the claim generation that row
 * must record.
 *
 * The claim row is the arbiter: `on conflict do nothing` then `for update`
 * makes every writer on one key wait for the one ahead of it, so of two
 * concurrent registrations by different owners exactly one is admitted. A key
 * an operator released (`owner_key` null) goes to the next writer, under the
 * generation the release bumped. A held key passes to another owner only when
 * the row being written is itself already on the key and its holder has no
 * other client there at all — revoked ones included, since a revoked client's
 * subjects were already seen by its owner. That is the origin claim flow
 * moving a single client, with its subjects, to its claimant; a new
 * registration never takes a held key.
 */
export async function claimSectorKey(
  tx: ClaimTx,
  sectorKey: string,
  ownerKey: string,
  clientId: string,
): Promise<number> {
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
  if (claim.ownerKey === ownerKey) return claim.generation;
  if (claim.ownerKey !== null) {
    await assertLoneClientMove(tx, sectorKey, claim.ownerKey, clientId);
  }
  await tx
    .update(claims)
    .set({ ownerKey, updatedAt: new Date() })
    .where(eq(claims.sectorKey, sectorKey));
  return claim.generation;
}

async function assertLoneClientMove(
  tx: ClaimTx,
  sectorKey: string,
  holderKey: string,
  clientId: string,
): Promise<void> {
  const onKey = eq(schema.oauthClients.sectorKey, sectorKey);
  const [self] = await tx
    .select({ id: schema.oauthClients.id })
    .from(schema.oauthClients)
    .where(and(onKey, eq(schema.oauthClients.id, clientId)))
    .limit(1);
  const [held] = await tx
    .select({ id: schema.oauthClients.id })
    .from(schema.oauthClients)
    .where(
      and(
        onKey,
        ne(schema.oauthClients.id, clientId),
        sql`${rowOwnerKey} = ${holderKey}`,
      ),
    )
    .limit(1);
  if (!self || held) throw new OAuthClientSectorClaimedError(sectorKey);
}

/** What an operator release of a sector key did. */
export interface SectorKeyRelease {
  sectorKey: string;
  /** The owner that held the key until now. */
  previousOwnerKey: string;
  /** The generation the next holder's subjects live under. */
  generation: number;
  /** Clients that lost the key (blocked `sector_released`). */
  blockedClientIds: string[];
}

/**
 * Operator release of a held sector key (a squatted sector).
 *
 * In one transaction, under the claim row's lock: every client still on the
 * key is blocked `sector_released` (the pairwise callback refuses it, so its
 * owner mints nothing further), the claim's generation is bumped, and the
 * claim is left unheld for the next registrant. The next holder's clients
 * record the new generation, and the pairwise subject sector mixes it in, so
 * none of them can meet a subject minted under an earlier generation — even
 * one a released client raced to mint while this ran. Answers `undefined`
 * for a key nobody holds.
 */
export async function releaseSectorClaim(
  db: Database,
  sectorKey: string,
): Promise<SectorKeyRelease | undefined> {
  const claims = schema.oauthClientSectorClaims;
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(claims)
      .where(eq(claims.sectorKey, sectorKey))
      .for("update");
    if (!claim || claim.ownerKey === null) return undefined;
    const blocked = await tx
      .update(schema.oauthClients)
      .set({ sectorKeyBlocked: "sector_released", updatedAt: new Date() })
      .where(
        and(
          eq(schema.oauthClients.sectorKey, sectorKey),
          isNull(schema.oauthClients.sectorKeyBlocked),
        ),
      )
      .returning({ id: schema.oauthClients.id });
    const generation = claim.generation + 1;
    await tx
      .update(claims)
      .set({ ownerKey: null, generation, updatedAt: new Date() })
      .where(eq(claims.sectorKey, sectorKey));
    return {
      sectorKey,
      previousOwnerKey: claim.ownerKey,
      generation,
      blockedClientIds: blocked.map((row) => row.id),
    };
  });
}

/** The generation a key's next row records without claiming it (revoked rows). */
export async function sectorGenerationOf(
  tx: ClaimTx,
  sectorKey: string,
): Promise<number> {
  const [claim] = await tx
    .select({ generation: schema.oauthClientSectorClaims.generation })
    .from(schema.oauthClientSectorClaims)
    .where(eq(schema.oauthClientSectorClaims.sectorKey, sectorKey))
    .limit(1);
  return claim?.generation ?? 0;
}
