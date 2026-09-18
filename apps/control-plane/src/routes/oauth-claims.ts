import {
  type AccountPrincipal,
  type ClaimMapping,
  ReservedClaimError,
  previewAccountClaims,
} from "@opensesame/oauth-provider";
import {
  type JsonObject,
  isBoolean,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { type Context, Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { authenticatedPrincipalId } from "./organizations.js";

export type ClientClaimMappingRecord = ClaimMapping;

async function ownedClientId(
  c: Context<{ Variables: Variables }>,
): Promise<string | Response> {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "not_found" }, 404);
  }
  const client = await ctx.stores.oauthClients.findById(id);
  if (!client || client.ownerPrincipalId !== principalId) {
    return c.json({ error: "not_found" }, 404);
  }
  return id;
}

function stringList(value: JsonObject[string]): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (isString(item)) out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

function mappingFromBody(body: JsonObject): ClaimMapping {
  const mapping: ClaimMapping = {};
  const allow = stringList(body.allow);
  if (allow) mapping.allow = allow;
  if (isJsonObject(body.claims)) mapping.claims = body.claims;
  if (isString(body.orgId)) mapping.orgId = body.orgId;
  return mapping;
}

function personaFromBody(body: JsonObject): AccountPrincipal {
  const persona: AccountPrincipal = {};
  if (isString(body.name)) persona.name = body.name;
  if (isString(body.email)) persona.email = body.email;
  if (isBoolean(body.emailVerified)) {
    persona.emailVerified = body.emailVerified;
  }
  if (isBoolean(body.emailAuthoritative)) {
    persona.emailAuthoritative = body.emailAuthoritative;
  }
  const groups = stringList(body.groups);
  if (groups) persona.groups = groups;
  if (isString(body.orgId)) persona.orgId = body.orgId;
  if (body.status === "suspended" || body.status === "missing") {
    persona.status = body.status;
  }
  return persona;
}

export const oauthClaimRoutes = new Hono<{ Variables: Variables }>();

oauthClaimRoutes.get("/:id/claims", requirePrincipal(), async (c) => {
  const owned = await ownedClientId(c);
  if (owned instanceof Response) return owned;
  const mapping = await c.get("ctx").stores.claimMappings.get(owned);
  return c.json({ mapping: mapping ?? { allow: ["name", "email"] } });
});

oauthClaimRoutes.put("/:id/claims", requirePrincipal(), async (c) => {
  const owned = await ownedClientId(c);
  if (owned instanceof Response) return owned;
  const value = overlapCast(await c.req.json().catch(() => ({})));
  if (!isJsonObject(value)) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const mapping = mappingFromBody(value);
  try {
    previewAccountClaims({
      pairwiseSub: "mapping-check",
      mapping,
      principal: { status: "active" },
    });
  } catch (error) {
    if (error instanceof ReservedClaimError) {
      return c.json({ error: "reserved_claim", claim: error.claim }, 400);
    }
    throw error;
  }
  await c.get("ctx").stores.claimMappings.set(owned, mapping);
  return c.json({ mapping });
});

oauthClaimRoutes.post("/:id/claim-preview", requirePrincipal(), async (c) => {
  const owned = await ownedClientId(c);
  if (owned instanceof Response) return owned;
  const value = overlapCast(await c.req.json().catch(() => ({})));
  if (!isJsonObject(value)) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const mapping =
    (await c.get("ctx").stores.claimMappings.get(owned)) ??
    ({ allow: ["name", "email"] } satisfies ClaimMapping);
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.filter((item): item is string => isString(item))
    : ["openid"];
  const consented = Array.isArray(value.consented)
    ? value.consented.filter((item): item is string => isString(item))
    : undefined;
  const persona = isJsonObject(value.persona)
    ? personaFromBody(value.persona)
    : {};
  try {
    const claims = previewAccountClaims({
      pairwiseSub: "synthetic-preview-sub",
      scope: scopes.join(" "),
      ...(consented ? { consented } : undefined),
      principal: { ...persona, status: persona.status ?? "active" },
      mapping,
    });
    return c.json({ claims, signed: false });
  } catch (error) {
    if (error instanceof ReservedClaimError) {
      return c.json({ error: "reserved_claim", claim: error.claim }, 400);
    }
    throw error;
  }
});
