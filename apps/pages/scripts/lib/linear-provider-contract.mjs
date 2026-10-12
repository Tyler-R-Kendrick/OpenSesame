/** Protocol authority for browser tests: substitutes HTTP, never app code or state. */
import { createHash } from "node:crypto";
import { isString } from "../../../../scripts/lib/json-boundary.mjs";

export const LINEAR_TEST_KEY = "lin_api_browser_contract_only";
export const LINEAR_TEST_CLIENT = "browser-contract-public-client";
const ISSUE = {
  id: "issue-contract",
  identifier: "TEST-42",
  title: "Protocol contract issue",
  description: null,
  url: "https://linear.app/browser-contract/issue/TEST-42",
};
const PROJECT = {
  id: "project-contract",
  name: "Protocol contract project",
  description: "Browser transport contract",
  url: "https://linear.app/browser-contract/project/contract",
};

async function authorize(route, { origin, base, check, consents }) {
  const url = new URL(route.request().url());
  consents.push(url);
  const params = url.searchParams;
  check(
    params.get("code_challenge_method") === "S256" &&
      /^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? ""),
    "OAuth consent uses S256 PKCE",
  );
  check(
    params.get("client_id") === LINEAR_TEST_CLIENT,
    "OAuth uses the deployment's registered public client ID",
  );
  check(
    params.get("redirect_uri") === `${origin}${base}auth/linear.html`,
    "OAuth callback preserves the deployment base path",
  );
  check(
    /^[a-f0-9]{64}$/.test(params.get("state") ?? ""),
    "OAuth state has 256 bits of random entropy",
  );
  await route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><title>Linear protocol test authority</title><p>Test-only OAuth consent transport.</p>",
  });
}

function tokenReply(request, state, json) {
  const form = new URLSearchParams(request.postData());
  state.calls.push({ path: "/oauth/token", form: Object.fromEntries(form) });
  if (state.revoked.has(form.get("refresh_token")))
    return json({ error: "invalid_grant" }, 400);
  const consent = state.codes.get(form.get("code"));
  if (!consent) throw new Error("Unregistered Linear authorization code");
  const verifier = form.get("code_verifier") ?? "";
  state.check(
    createHash("sha256").update(verifier).digest("base64url") ===
      consent.searchParams.get("code_challenge"),
    "Token exchange proves the original PKCE verifier",
  );
  state.check(
    form.get("grant_type") === "authorization_code" &&
      form.get("client_id") === LINEAR_TEST_CLIENT &&
      !form.has("client_secret"),
    "Public-client exchange sends no OAuth client secret",
  );
  state.check(
    form.get("redirect_uri") === consent.searchParams.get("redirect_uri"),
    "Token exchange retains the exact registered callback",
  );
  const actor = consent.searchParams.get("actor");
  const suffix = state.uniqueGrants ? `-${form.get("code")}` : "";
  const access = `contract-oauth-${actor}${suffix}`;
  const refresh = `contract-refresh-${actor}${suffix}`;
  state.grants.set(access, {
    actor,
    access,
    refresh,
    scope: consent.searchParams.get("scope"),
    workspace: state.wrongWorkspaceCode === form.get("code"),
  });
  return json({
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: 3600,
    scope: consent.searchParams.get("scope"),
  });
}

function webhookReply(body, state) {
  const query = body.query;
  if (query.includes("OpenSesameWebhooks"))
    return {
      webhooks: {
        nodes: [...state.webhooks.values()],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  if (query.includes("OpenSesameDeleteWebhook")) {
    state.webhooks.delete(body.variables.id);
    return { webhookDelete: { success: true } };
  }
  if (!query.includes("OpenSesameWebhook")) return null;
  const input = body.variables.input;
  state.check(
    input.url === "https://hooks.example.test/linear" &&
      input.resourceTypes.includes("Issue") &&
      input.resourceTypes.includes("Comment") &&
      input.allPublicTeams === true,
    "Webhook mutation provisions the configured HTTPS receiver and resources",
  );
  state.check(
    isString(input.secret) && input.secret.length >= 32,
    "Webhook provisioning sends a generated signing secret",
  );
  state.check(
    isString(input.id),
    "Webhook provisioning supplies its recoverable stable ID",
  );
  state.webhooks.set(input.id, { ...input, enabled: true });
  return {
    webhookCreate: { success: true, webhook: { id: input.id, enabled: true } },
  };
}

function graphqlReply(body, state, authorization) {
  const query = body.query;
  if (query.includes("OpenSesameAccount"))
    return {
      viewer: {
        id: "viewer-contract",
        name: "Protocol test account",
        email: "contract@example.test",
      },
      organization: {
        id: state.grants.get(authorization?.slice(7))?.workspace
          ? "workspace-other"
          : "workspace-contract",
        name: "Browser contract workspace",
        urlKey: "browser-contract",
      },
      teams: {
        nodes: [{ id: "team-contract", name: "Contract team", key: "TEST" }],
      },
    };
  if (query.includes("OpenSesameIssues")) return { issues: { nodes: [ISSUE] } };
  if (query.includes("OpenSesameProjects"))
    return { projects: { nodes: [PROJECT] } };
  if (query.includes("OpenSesameCreateIssue")) {
    state.issueTitle = body.variables.input.title;
    state.check(
      body.variables.input.teamId === "team-contract",
      "Issue creation sends the selected verified team",
    );
    return {
      issueCreate: {
        success: true,
        issue: { ...ISSUE, title: state.issueTitle },
      },
    };
  }
  const webhook = webhookReply(body, state);
  if (webhook) return webhook;
  throw new Error(`Unexpected Linear GraphQL operation: ${query}`);
}

function checkCredential(state, authorization, body) {
  state.check(
    authorization === LINEAR_TEST_KEY ||
      state.grants.has(authorization?.slice(7)),
    "Only the configured credential reaches Linear's API",
  );
  if (body.query.includes("Webhook") && authorization !== LINEAR_TEST_KEY)
    state.check(
      state.grants
        .get(authorization?.slice(7))
        ?.scope.split(",")
        .includes("admin"),
      "OAuth webhook requests use an explicitly granted admin permission",
    );
}

function answerGraphql(request, state, json) {
  const body = request.postDataJSON();
  const authorization = request.headers().authorization;
  state.calls.push({ path: "/graphql", body, authorization });
  if (
    authorization === "lin_api_invalid_contract" ||
    state.revoked.has(authorization?.slice(7))
  )
    return json({
      errors: [
        {
          message: "Invalid authorization",
          extensions: { code: "AUTHENTICATION_ERROR" },
        },
      ],
    });
  checkCredential(state, authorization, body);
  if (
    (state.failList && body.query.includes("OpenSesameWebhooks")) ||
    (state.failDelete && body.query.includes("OpenSesameDeleteWebhook"))
  )
    return json({ errors: [{ message: "Provider unavailable" }] }, 503);
  const data = graphqlReply(body, state, authorization);
  if (state.loseCreate && body.query.includes("OpenSesameWebhook(")) {
    state.loseCreate = false;
    return json({ errors: [{ message: "Response lost after commit" }] }, 503);
  }
  return json({ data });
}

async function answerApi(route, state) {
  const request = route.request();
  const url = new URL(request.url());
  const cors = {
    "access-control-allow-origin": state.origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  if (request.method() === "OPTIONS")
    return route.fulfill({ status: 204, headers: cors });
  const json = (data, status = 200) => {
    if (status >= 400) state.expectedResponses.set(request, status);
    return route.fulfill({
      status,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  };
  if (url.pathname === "/oauth/token") return tokenReply(request, state, json);
  if (url.pathname === "/oauth/revoke") {
    const form = new URLSearchParams(request.postData());
    state.calls.push({ path: url.pathname, form: Object.fromEntries(form) });
    if (state.revoked.has(form.get("token")))
      return json({ error: "invalid_token" }, 400);
    state.revoked.add(form.get("token"));
    return json({ success: true });
  }
  if (url.pathname !== "/graphql")
    throw new Error(`Unexpected Linear endpoint ${url.pathname}`);
  return answerGraphql(request, state, json);
}

async function providerCallback(page, state, response) {
  const url = new URL(page.url());
  if (url.origin !== "https://linear.app")
    throw new Error("Consent did not navigate to Linear");
  if (response.code) state.codes.set(response.code, url);
  const callback = new URL(url.searchParams.get("redirect_uri"));
  for (const name of ["code", "state", "error"]) {
    const value =
      name === "state" ? url.searchParams.get("state") : response[name];
    if (value) {
      callback.searchParams.set(name, value);
    }
  }
  await page.goto(callback.href, { waitUntil: "commit" });
}

export async function routeLinearProvider(context, { origin, base, check }) {
  const state = {
    origin,
    base,
    check,
    calls: [],
    consents: [],
    codes: new Map(),
    webhooks: new Map(),
    issueTitle: "",
    expectedCallbacks: new Set(),
    expectedResponses: new Map(),
    grants: new Map(),
    revoked: new Set(),
    uniqueGrants: false,
    wrongWorkspaceCode: "",
    failList: false,
    failDelete: false,
    loseCreate: false,
  };
  await context.route(`${origin}${base}os-runtime-config.json`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ linearClientId: LINEAR_TEST_CLIENT }),
    }),
  );
  await context.route("https://linear.app/oauth/authorize?**", (route) =>
    authorize(route, state),
  );
  await context.route("https://api.linear.app/**", (route) =>
    answerApi(route, state),
  );
  return {
    expectedCallbacks: state.expectedCallbacks,
    expectedResponses: state.expectedResponses,
    remote: state,
    calls: state.calls,
    consents: state.consents,
    consent: (page, code) => providerCallback(page, state, { code }),
    deny: (page) => providerCallback(page, state, { error: "access_denied" }),
    get issueTitle() {
      return state.issueTitle;
    },
  };
}
