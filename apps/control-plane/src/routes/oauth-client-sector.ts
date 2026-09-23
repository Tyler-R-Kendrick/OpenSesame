import { redirectUrisOutsideSector } from "@opensesame/contracts";
import { OAuthClientSectorClaimedError } from "@opensesame/database";
import { pairwiseSectorKey } from "@opensesame/oauth-provider";
import { type BoundaryValue, isString } from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import { guardedFetch } from "../services/guarded-fetch.js";

/**
 * Sector policy for the registration API: who may hold a sector, and what a
 * registrant must show before naming one.
 *
 * Two clients sharing a sector see the same pairwise subject for the same
 * person, which is exactly the linkage pairwise subjects exist to prevent, so
 * a sector key has one owner (`sectorClaimedByAnother`, and on Postgres the
 * claim row). Being first is not ownership, though: nothing in an https URL's
 * shape shows its registrant controls it. So a client whose redirect URIs all
 * live on the sector's host (or its subdomains) is taken to be that host's —
 * it can receive codes nowhere else, as OIDC Core §8.1 derives a sector from
 * redirect hosts — and any other client must publish the OIDC
 * `sector_identifier_uri` document on the sector's own host, listing every
 * redirect URI, which Identity fetches through the DNS-pinned guarded fetch.
 */

const SECTOR_DOCUMENT_MAX_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Loopback redirects are how a developer's local RP runs; a deployment on dev
 * defaults (never production — `assertSecureConfig` refuses the pair) does not
 * ask them for a sector document. Everywhere else a loopback redirect is just
 * another host outside the sector.
 */
function devLoopback(ctx: AppContext, uri: string): boolean {
  if (!ctx.config.allowDevDefaults) return false;
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Whether the sector document at `uri` lists every one of `redirectUris`. */
async function sectorDocumentLists(
  uri: string,
  redirectUris: readonly string[],
): Promise<boolean> {
  try {
    const response = await guardedFetch(uri, true, {
      headers: { accept: "application/json" },
      maxBytes: SECTOR_DOCUMENT_MAX_BYTES,
    });
    if (response.status !== 200) return false;
    const listed: BoundaryValue = await response.json();
    if (!Array.isArray(listed)) return false;
    const strings = listed.filter(isString);
    if (strings.length !== listed.length) return false;
    const set = new Set(strings);
    return redirectUris.every((redirect) => set.has(redirect));
  } catch {
    // Refused destination, timeout, oversize or unparsable body: unproven.
    return false;
  }
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

/**
 * `null` when the registrant may name `sectorIdentifier` for `redirectUris`;
 * otherwise the 400 to answer. `sectorIdentifierUri` must live on the sector's
 * own host: a document on some other host proves nothing about the sector.
 */
export async function sectorControlRefusal(
  ctx: AppContext,
  sectorIdentifier: string,
  redirectUris: readonly string[],
  sectorIdentifierUri: string | undefined,
): Promise<Response | null> {
  const outside = redirectUrisOutsideSector(
    sectorIdentifier,
    redirectUris,
  ).filter((uri) => !devLoopback(ctx, uri));
  if (outside.length === 0) return null;
  if (
    sectorIdentifierUri &&
    sameHost(sectorIdentifierUri, sectorIdentifier) &&
    (await sectorDocumentLists(sectorIdentifierUri, redirectUris))
  ) {
    return null;
  }
  return Response.json(
    {
      error: "sector_not_proven",
      message:
        "every redirect URI must be on the sectorIdentifier's host (or a subdomain), or sectorIdentifierUri must name an https document on that host listing every redirect URI",
      redirectUris: outside,
    },
    { status: 400 },
  );
}

/**
 * A sector key may not be claimed across owners. Sharing one between a single
 * owner's clients is a legitimate choice; taking another owner's is a way to
 * learn the `sub` they see. The `sub` is keyed on `pairwiseSectorKey`, not on
 * the redirect host or the spelling, so the check looks the key up
 * (`findBySectorKey`), revoked clients included — their owner already saw
 * those subjects. A blocked row (migration 0029, or an operator release) holds
 * nothing. This check answers early; on Postgres the sector claim row is the
 * arbiter (`OAuthClientSectorClaimedError`), which also decides two concurrent
 * registrations. The issuer's own host is reserved for the first-party clients
 * oidc-provider keys on it.
 */
export async function sectorClaimedByAnother(
  ctx: AppContext,
  principalId: string,
  sectorIdentifier: string,
): Promise<boolean> {
  const key = pairwiseSectorKey(sectorIdentifier);
  if (key === pairwiseSectorKey(new URL(ctx.config.issuer).origin)) {
    return true;
  }
  const claimants = await ctx.stores.oauthClients.findBySectorKey(key);
  return claimants.some(
    (client) =>
      !client.sectorKeyBlocked && client.ownerPrincipalId !== principalId,
  );
}

export const SECTOR_TAKEN = {
  error: "sector_identifier_taken",
  message:
    "another principal already registered a client under this sectorIdentifier",
} as const;

/** The store's sector claim is the last word: a lost race is 409, not 500. */
export function sectorTakenOrThrow(err: BoundaryValue): Response {
  if (err instanceof OAuthClientSectorClaimedError) {
    return Response.json(SECTOR_TAKEN, { status: 409 });
  }
  throw err;
}
