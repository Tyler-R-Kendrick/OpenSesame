/**
 * A stand-in for the Identity API's organization sign-in routes, for the
 * panel tests: one organization, its domains and its SCIM tokens, answered
 * from memory the way `packages/control-plane` answers them — a claimed
 * domain waits for its TXT record, a verify settles it, a minted token's
 * plaintext is in the mint answer only, and a revoke answers 204.
 */

import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";

export type Seen = { method: string; path: string; body: string | null };

export type Domain = {
  domain: string;
  txtRecord: string;
  verifiedAt: string | null;
};

export type Token = { id: string; createdAt: string; revokedAt: string | null };

export const ACME = {
  id: "org_1",
  slug: "acme",
  displayName: "Acme",
  role: "owner",
  ssoIssuer: "https://idp.acme.example",
  ssoClientSecretConfigured: false,
};

function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Store = {
  domains: Domain[];
  tokens: Token[];
  taken: Set<string>;
  minted: number;
};

const BASE = "/v1/organizations/org_1";

function claim(store: Store, body: string | null): Response {
  const read: BoundaryValue = JSON.parse(body ?? "{}");
  const domain =
    isJsonObject(read) && typeof read.domain === "string" ? read.domain : "";
  if (store.taken.has(domain)) {
    return json(
      {
        error: "domain_taken",
        message: "That domain is already claimed by another organization.",
      },
      409,
    );
  }
  const row = {
    domain,
    txtRecord: `opensesame-domain-verify=tok_${store.domains.length + 1}`,
    verifiedAt: null,
  };
  store.domains = [...store.domains.filter((d) => d.domain !== domain), row];
  return json(row, 201);
}

function domainRoute(store: Store, method: string, tail: string): Response {
  const verify = tail.endsWith("/verify");
  const name = decodeURIComponent(
    tail.slice(1, verify ? -"/verify".length : undefined),
  );
  const row = store.domains.find((d) => d.domain === name);
  if (!row) return json({ error: "not_found" }, 404);
  if (verify && method === "POST") {
    const next = { ...row, verifiedAt: "2026-09-26T00:00:00.000Z" };
    store.domains = store.domains.map((d) => (d.domain === name ? next : d));
    return json(next);
  }
  if (method === "DELETE") {
    store.domains = store.domains.filter((d) => d.domain !== name);
    return new Response(null, { status: 204 });
  }
  return json({ error: "not_found" }, 404);
}

function mint(store: Store): Response {
  store.minted += 1;
  const id = `sct_id_${store.minted}`;
  store.tokens = [
    ...store.tokens,
    { id, createdAt: "2026-09-26T00:00:00.000Z", revokedAt: null },
  ];
  return json(
    {
      id,
      token: `sct_plaintext_${store.minted}`,
      scimBaseUrl: "https://id.example/v1/organizations/org_1/scim/v2",
    },
    201,
  );
}

function tokenRoute(store: Store, method: string, tail: string): Response {
  if (tail === "" && method === "GET") return json({ tokens: store.tokens });
  if (tail === "" && method === "POST") return mint(store);
  const id = decodeURIComponent(tail.slice(1));
  if (method === "DELETE" && store.tokens.some((t) => t.id === id)) {
    store.tokens = store.tokens.map((t) =>
      t.id === id ? { ...t, revokedAt: "2026-09-26T01:00:00.000Z" } : t,
    );
    return new Response(null, { status: 204 });
  }
  return json({ error: "not_found" }, 404);
}

function route(
  store: Store,
  organizations: BoundaryValue[],
  seen: Seen,
): Response {
  const { method, path, body } = seen;
  if (path === "/v1/organizations" && method === "GET") {
    return json({ organizations });
  }
  if (path === BASE && method === "PATCH") return json({ id: "org_1" });
  if (path === `${BASE}/domains` && method === "GET") {
    return json({ domains: store.domains });
  }
  if (path === `${BASE}/domains` && method === "POST") {
    return claim(store, body);
  }
  if (path.startsWith(`${BASE}/domains/`)) {
    return domainRoute(store, method, path.slice(`${BASE}/domains`.length));
  }
  if (path.startsWith(`${BASE}/scim/tokens`)) {
    return tokenRoute(store, method, path.slice(`${BASE}/scim/tokens`.length));
  }
  return json({ error: "not_found" }, 404);
}

export function orgSignInServer(
  options: {
    organizations?: BoundaryValue[];
    domains?: Domain[];
    tokens?: Token[];
    /** Domains another organization already holds. */
    taken?: string[];
  } = {},
) {
  const organizations = options.organizations ?? [ACME];
  const store: Store = {
    domains: [...(options.domains ?? [])],
    tokens: [...(options.tokens ?? [])],
    taken: new Set(options.taken ?? []),
    minted: 0,
  };
  const seen: Seen[] = [];
  async function fetch(path: string, init: RequestInit = {}) {
    const call = {
      method: init.method ?? "GET",
      path,
      body: init.body ? String(init.body) : null,
    };
    seen.push(call);
    return route(store, organizations, call);
  }
  return {
    fetch,
    seen,
    tokens: () => store.tokens,
    domains: () => store.domains,
  };
}
