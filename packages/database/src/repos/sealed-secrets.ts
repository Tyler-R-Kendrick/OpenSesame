import type { EventSealer } from "../event-seal.js";
import { openSecretText, sealSecretText } from "../secret-seal.js";
import type { Repositories } from "./interfaces.js";

function overriding<T extends object>(base: T, own: Partial<T>): T {
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, own);
}

function secretTransforms(sealer: EventSealer) {
  const text = (
    opening: boolean,
    table: string,
    id: string,
    scope: string,
    value: string,
  ) =>
    (opening ? openSecretText : sealSecretText)(
      sealer,
      `${table}:${id}`,
      scope,
      value,
    );
  const required = <T>(value: T | null): T => {
    if (value === null) throw new Error("Secret repository returned no record");
    return value;
  };
  const byo = (
    opening: boolean,
    row: Awaited<ReturnType<Repositories["byoUpstreams"]["getById"]>>,
  ) =>
    row === null || row.clientSecret === undefined
      ? row
      : {
          ...row,
          clientSecret: text(
            opening,
            "byo_upstreams.client_secret",
            row.id,
            "deployment",
            row.clientSecret,
          ),
        };
  const webhook = (
    opening: boolean,
    row: Awaited<ReturnType<Repositories["webhookEndpoints"]["getById"]>>,
  ) =>
    row === null
      ? row
      : {
          ...row,
          secret: text(
            opening,
            "webhook_endpoints.secret",
            row.id,
            row.principalId,
            row.secret,
          ),
        };
  const push = (
    opening: boolean,
    row: Awaited<ReturnType<Repositories["pushSubscriptions"]["getById"]>>,
  ) =>
    row === null
      ? row
      : {
          ...row,
          endpoint: text(
            opening,
            "push_subscriptions.endpoint",
            row.endpointDigest,
            row.principalId,
            row.endpoint,
          ),
          authSecret: text(
            opening,
            "push_subscriptions.auth_secret",
            row.endpointDigest,
            row.principalId,
            row.authSecret,
          ),
        };
  return { byo, webhook, push, required };
}

/** All reversible secret fields owned by the domain repository boundary. */
export function withSealedSecrets(
  repos: Repositories,
  sealer: EventSealer,
): Repositories {
  const { byo, webhook, push, required } = secretTransforms(sealer);
  const b = repos.byoUpstreams;
  const w = repos.webhookEndpoints;
  const p = repos.pushSubscriptions;
  return overriding(repos, {
    byoUpstreams: overriding(b, {
      create: async (row) =>
        required(byo(true, await b.create(required(byo(false, row))))),
      getById: async (id) => byo(true, await b.getById(id)),
      findByIssuer: async (issuer) => byo(true, await b.findByIssuer(issuer)),
      list: async () => (await b.list()).map((row) => required(byo(true, row))),
      setState: async (id, state) => byo(true, await b.setState(id, state)),
    }),
    webhookEndpoints: overriding(w, {
      create: async (row, uow) =>
        required(
          webhook(true, await w.create(required(webhook(false, row)), uow)),
        ),
      getById: async (id) => webhook(true, await w.getById(id)),
      listForPrincipal: async (id) =>
        (await w.listForPrincipal(id)).map((row) =>
          required(webhook(true, row)),
        ),
    }),
    pushSubscriptions: overriding(p, {
      create: async (row, uow) =>
        required(push(true, await p.create(required(push(false, row)), uow))),
      getById: async (id) => push(true, await p.getById(id)),
      findByEndpointDigest: async (digest) =>
        push(true, await p.findByEndpointDigest(digest)),
      listForPrincipal: async (id) =>
        (await p.listForPrincipal(id)).map((row) => required(push(true, row))),
    }),
  });
}
