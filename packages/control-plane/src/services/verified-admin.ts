/**
 * Mutations that need a verified identity, each demanding a `VerifiedPrincipal`
 * proof about the exact principal it acts for (ADR 0178).
 *
 * The routes used to run the assurance check and then hand a store an owner id
 * string; nothing tied the two together. These functions cannot be called
 * without the proof, and a record they write must belong to the principal the
 * proof is about. The stores underneath stay reachable (`ctx.stores`), so this
 * is the path routes take, not a seal.
 */

import { randomUUID } from "node:crypto";
import type { Named } from "@gdp-ts/core";
import {
  DEFAULT_AUTHENTICATION_CONFIGURATIONS,
  mintAuthenticationApplicationSecret,
} from "@opensesame/auth-upstream";
import type {
  AuthenticationApplication,
  Organization,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";
import type { ActorId } from "../lib/ids.js";
import type { VerifiedPrincipal } from "../proofs/verified-principal.js";

type Clients = AppContext["stores"]["oauthClients"];
type StoreClient = Parameters<Clients["insertAtomic"]>[0];
type InsertOptions = Parameters<Clients["insertAtomic"]>[1];

function assertOwns(client: StoreClient, ownerId: string): void {
  if (client.ownerPrincipalId !== ownerId) {
    throw new Error("OAuth client is owned by a different principal");
  }
}

/** Registers a client (or its rotation successor) for the verified principal. */
export function insertOAuthClient<A>(
  ctx: AppContext,
  owner: Named<A, ActorId>,
  _proof: VerifiedPrincipal<A>,
  client: StoreClient,
  options?: InsertOptions,
): ReturnType<Clients["insertAtomic"]> {
  assertOwns(client, owner.value);
  return ctx.stores.oauthClients.insertAtomic(client, options);
}

/** Replaces a client the verified principal owns (patch, retire, revoke). */
export function replaceOAuthClient<A>(
  ctx: AppContext,
  owner: Named<A, ActorId>,
  _proof: VerifiedPrincipal<A>,
  client: StoreClient,
): ReturnType<Clients["update"]> {
  assertOwns(client, owner.value);
  return ctx.stores.oauthClients.update(client);
}

export interface NewAuthenticationApplication {
  readonly organizationId?: string | undefined;
  readonly displayName: string;
  readonly rpId: string;
  readonly origins: readonly string[];
}

export interface CreatedAuthenticationApplication {
  readonly application: AuthenticationApplication;
  /** The one-time API secret; only its hash is stored. */
  readonly secret: string;
}

/**
 * Creates an authentication application owned by the verified principal and
 * returns it with its one-time API secret. Whether the principal may attach it
 * to an organization is the caller's check; this only fixes who owns it.
 */
export async function createAuthenticationApplication<A>(
  ctx: AppContext,
  owner: Named<A, ActorId>,
  _proof: VerifiedPrincipal<A>,
  input: NewAuthenticationApplication,
): Promise<CreatedAuthenticationApplication> {
  const now = ctx.clock();
  const minted = mintAuthenticationApplicationSecret();
  const application: AuthenticationApplication = {
    id: `authapp_${randomUUID()}`,
    ownerPrincipalId: owner.value,
    ...(input.organizationId
      ? { organizationId: input.organizationId }
      : undefined),
    displayName: input.displayName,
    rpId: input.rpId,
    origins: [...new Set(input.origins)],
    secretHash: minted.secretHash,
    secretPrefix: minted.secretPrefix,
    apiKeys: [
      {
        id: `authkey_${randomUUID()}`,
        secretHash: minted.secretHash,
        secretPrefix: minted.secretPrefix,
        state: "active",
        createdAt: now.toISOString(),
      },
    ],
    configurations: DEFAULT_AUTHENTICATION_CONFIGURATIONS.map(
      (configuration) => ({
        ...configuration,
        hints: [...configuration.hints],
      }),
    ),
    manualTokensEnabled: false,
    magicLinksEnabled: false,
    state: "active",
    createdAt: now,
    updatedAt: now,
  };
  await ctx.authenticationStores.applications.create(application);
  return { application, secret: minted.secret };
}

/**
 * Creates an organization on behalf of the verified principal who founds it.
 * The row must name that principal as its creator; the founding owner
 * membership stays with the route.
 */
export async function createOrganization<A>(
  ctx: AppContext,
  founder: Named<A, ActorId>,
  _proof: VerifiedPrincipal<A>,
  organization: Organization,
): Promise<void> {
  if (organization.createdBy !== founder.value) {
    throw new Error("organization was created by a different principal");
  }
  await ctx.stores.organizations.set(organization.id, organization);
}
