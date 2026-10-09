/**
 * Receiver authorization for `GET /v1/principals/mapping/resolve` (ID-MAPPING).
 *
 * Two explicit modes, chosen at boot (`OPENSESAME_MAPPING_AUTH`), never
 * both and never a fallback from one to the other:
 *
 * - `shared_secret`: the existing `OPENSESAME_MAPPING_RESOLVE_TOKEN` compare.
 * - `mtls`: the request's transport evidence must resolve to an
 *   `identity_mapping_client` binding that lists
 *   `principals.mapping.resolve`. The bound service identity is authorized
 *   for that operation and nothing else — it is not a principal, it holds no
 *   session, and every other route still answers 401 (AT-MAPPING-SCOPE).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { overlapCast } from "@opensesame/os-domain";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import type { Variables } from "../middleware/context.js";
import { requestEvidenceOf } from "./request-evidence.js";

export const MAPPING_RESOLVE_OPERATION = "principals.mapping.resolve";

export type MappingAuthorization =
  | { ok: true; actor: "shared_secret" }
  | {
      ok: true;
      actor: "service";
      servicePrincipal: string;
      bindingId: string;
      peerThumbprint: string;
    }
  | { ok: false; status: 401 | 403 | 503; error: string };

export function tokenEq(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

/** The Node request behind a Hono context (`@hono/node-server` bindings). */
export function incomingOf(
  c: Context<{ Variables: Variables }>,
): IncomingMessage | undefined {
  const env: { incoming?: IncomingMessage } | undefined = overlapCast(c.env);
  return env?.incoming;
}

function sharedSecret(
  c: Context<{ Variables: Variables }>,
  expected: string,
): MappingAuthorization {
  if (!expected)
    return { ok: false, status: 503, error: "mapping_resolve_disabled" };
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  const headerToken = c.req.header("x-opensesame-mapping-token")?.trim() ?? "";
  const presented = bearer || headerToken;
  if (!presented || !tokenEq(presented, expected)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true, actor: "shared_secret" };
}

function mutualTls(c: Context<{ Variables: Variables }>): MappingAuthorization {
  const evidence = requestEvidenceOf(incomingOf(c));
  if (!evidence) return { ok: false, status: 401, error: "unauthorized" };
  const admitted = evidence.admit(
    "identity_mapping_client",
    MAPPING_RESOLVE_OPERATION,
  );
  if (!admitted.ok) {
    // A plain-listener call to a certificate-only receiver is a policy
    // mismatch (403); everything else is an unauthenticated peer (401).
    const status = admitted.code === "listener_policy_mismatch" ? 403 : 401;
    return { ok: false, status, error: admitted.code };
  }
  const acting = admitted.caller.originating ?? admitted.caller.peer;
  return {
    ok: true,
    actor: "service",
    servicePrincipal: admitted.caller.binding.service_principal,
    bindingId: admitted.caller.binding.id,
    peerThumbprint: acting.leafThumbprintSha256(),
  };
}

/** Authorize a mapping-resolve call under the configured mode. */
export function authorizeMappingResolve(
  c: Context<{ Variables: Variables }>,
  ctx: AppContext,
): MappingAuthorization {
  return ctx.config.transport?.mappingAuth === "mtls"
    ? mutualTls(c)
    : sharedSecret(c, ctx.config.mappingResolveToken);
}
