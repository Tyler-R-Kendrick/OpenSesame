import { createHash, randomBytes } from "node:crypto";
import {
  digestAgentClaimAttemptToken,
  overlapCast,
} from "@opensesame/os-domain";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext } from "../context.js";
import type { Variables } from "../middleware/context.js";
import {
  AGENT_AUTH_CLAIM_CSP,
  AGENT_AUTH_OAUTH_CLIENT_ID,
  agentAuthClaimRedirectUri,
  renderAgentAuthClaimPage,
  renderAgentAuthLoginPage,
  safeAgentAuthReturnTo,
} from "../ui/agent-auth-pages.js";

const AGENT_AUTH_OIDC_COOKIE = "os_agent_auth_oidc";
function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function exchangeAgentAuthCode(
  ctx: AppContext,
  code: string,
  codeVerifier: string,
): Promise<string | undefined> {
  const issuer = ctx.config.issuer.replace(/\/+$/u, "");
  const redirectUri = agentAuthClaimRedirectUri(issuer);
  try {
    const tokenRes = await fetch(`${issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: AGENT_AUTH_OAUTH_CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    const body = overlapCast(await tokenRes.json());
    if (typeof body.access_token === "string") return body.access_token;
  } catch {
    return undefined;
  }
  return undefined;
}

async function establishProvisionalSession(
  c: Context,
  ctx: AppContext,
  accountId: string,
): Promise<void> {
  const now = ctx.clock();
  const sessionId = `ps_${randomBytes(16).toString("hex")}`;
  ctx.stores.provisionalSessions.set(sessionId, {
    id: sessionId,
    principalId: accountId,
    quotaProfile: "anonymous",
    allowedActions: [
      "claim.create",
      "agent.register_ephemeral",
      "session.continue_anonymous",
    ],
    createdAt: now,
    expiresAt: new Date(now.getTime() + ctx.config.provisionalTtlMs),
  });
  const pst = `pst_${randomBytes(24).toString("base64url")}`;
  ctx.stores.provisionalTokens.set(pst, sessionId);
  setCookie(c, ctx.config.provisionalCookieName, pst, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(ctx.config.provisionalTtlMs / 1000),
    secure: ctx.config.publicUrl.startsWith("https://"),
  });
}

async function handleClaimResume(c: Context): Promise<Response> {
  const ctx = c.get("ctx");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", AGENT_AUTH_CLAIM_CSP);
  const raw = getCookie(c, AGENT_AUTH_OIDC_COOKIE);
  deleteCookie(c, AGENT_AUTH_OIDC_COOKIE, { path: "/" });
  let stored: { v?: string; r?: string; s?: string } = {};
  try {
    stored = raw ? overlapCast(JSON.parse(raw)) : {};
  } catch {
    stored = {};
  }
  const returnTo = safeAgentAuthReturnTo(
    typeof stored.r === "string" ? stored.r : "/claim",
  );
  const login = () =>
    c.html(
      renderAgentAuthLoginPage({
        returnTo,
        publicUrl: ctx.config.publicUrl,
      }),
      400,
    );
  if (c.req.query("error") || !stored.v || !stored.s) return login();
  if (c.req.query("state") !== stored.s) return login();
  const code = c.req.query("code");
  if (!code) return c.redirect(returnTo, 303);
  const accessToken = await exchangeAgentAuthCode(ctx, code, stored.v);
  if (!accessToken) return login();
  const provider: {
    AccessToken: {
      find: (value: string) => Promise<{ accountId?: string } | undefined>;
    };
  } = overlapCast(ctx.oauth.provider);
  const token = await provider.AccessToken.find(accessToken);
  const accountId = token?.accountId;
  if (!accountId) return login();
  await establishProvisionalSession(c, ctx, accountId);
  return c.redirect(returnTo, 303);
}

export function registerAgentAuthCeremony(
  routes: Hono<{ Variables: Variables }>,
): void {
  registerAgentAuthClaimRoutes(routes);
  registerAgentAuthLoginRoutes(routes);
}

function registerAgentAuthClaimRoutes(
  routes: Hono<{ Variables: Variables }>,
): void {
  routes.get("/claim", async (c) => {
    const token = c.req.query("claim_attempt_token") ?? "";
    const principalId = c.get("principalId");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", AGENT_AUTH_CLAIM_CSP);
    if (!principalId) {
      const returnTo = `/claim?claim_attempt_token=${encodeURIComponent(token)}`;
      return c.redirect(
        `/login?return_to=${encodeURIComponent(returnTo)}`,
        303,
      );
    }
    const ctx = c.get("ctx");
    const digest = digestAgentClaimAttemptToken(ctx.config.claimPepper, token);
    const attempt = digest
      ? await ctx.repos.agentAuth.getClaimAttemptByTokenDigest(digest)
      : null;
    const registration = attempt
      ? await ctx.repos.agentAuth.getRegistrationById(attempt.registrationId)
      : null;
    return c.html(
      renderAgentAuthClaimPage({
        claimAttemptToken: token,
        principalId,
        ...(registration
          ? {
              registrationId: registration.id,
              scopes: registration.postClaimScopes,
            }
          : {}),
      }),
    );
  });
}

function registerAgentAuthLoginRoutes(
  routes: Hono<{ Variables: Variables }>,
): void {
  routes.post("/login/start", async (c) => {
    const ctx = c.get("ctx");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", AGENT_AUTH_CLAIM_CSP);
    const form = await c.req.parseBody();
    const returnTo = safeAgentAuthReturnTo(
      typeof form.return_to === "string" ? form.return_to : "/claim",
    );
    const principalId = c.get("principalId");
    if (principalId) {
      return c.redirect(returnTo, 303);
    }
    const issuer = ctx.config.issuer.replace(/\/+$/u, "");
    const redirectUri = agentAuthClaimRedirectUri(issuer);
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    setCookie(
      c,
      AGENT_AUTH_OIDC_COOKIE,
      JSON.stringify({ v: verifier, r: returnTo, s: state }),
      {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 600,
        secure: ctx.config.publicUrl.startsWith("https://"),
      },
    );
    const authorize = new URL(`${issuer}/auth`);
    authorize.searchParams.set("client_id", AGENT_AUTH_OAUTH_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid");
    authorize.searchParams.set("code_challenge", pkceChallenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    const provider =
      typeof form.provider === "string" ? form.provider.trim() : "";
    if (/^[a-z0-9._-]{1,64}$/i.test(provider)) {
      authorize.searchParams.set("login_hint_provider", provider);
      authorize.searchParams.set("kc_idp_hint", provider);
    }
    return c.redirect(authorize.toString(), 303);
  });

  routes.get("/claim/resume", async (c) => handleClaimResume(c));

  routes.get("/login", async (c) => {
    const ctx = c.get("ctx");
    const returnTo = safeAgentAuthReturnTo(
      c.req.query("return_to") ?? "/claim",
    );
    const principalId = c.get("principalId");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy", AGENT_AUTH_CLAIM_CSP);
    if (principalId) {
      return c.redirect(returnTo, 303);
    }
    return c.html(
      renderAgentAuthLoginPage({
        returnTo,
        publicUrl: ctx.config.publicUrl,
      }),
    );
  });
}
