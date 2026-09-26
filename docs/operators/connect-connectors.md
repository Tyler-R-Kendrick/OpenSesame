# Connectors on Vercel Connect (ADR 0146)

Every service on the Connections page opens with its whole configuration
filled in — the OAuth server, client authentication, PKCE, scopes and their
meaning, extra authorization parameters, where to register a client or issue
a key — from [`spec/connectors/connect-presets.json`](../../spec/connectors/connect-presets.json)
and Vercel Connect's own service registry
([`connect-services.json`](../../spec/connectors/connect-services.json)).
This runbook takes one connector from nothing to a proven user token.

## 1. The relay (once per deployment)

A Vercel deployment of `apps/pages` serves the relay at `/api/connect/*`
(ADR 0127). Set on the project:

| Variable | What it is |
| --- | --- |
| `VERCEL_TOKEN` | An access token for the team that owns the connectors. The page never sees it. |
| `VERCEL_TEAM_ID` | That team (`team_…`). |
| `VERCEL_PROJECT_ID` | Optional: link new connectors to this project. |
| `OPENSESAME_CONNECT_MANAGE_KEY` | ≥ 32 characters (`openssl rand -base64 48`). Every create, edit, authorize, revoke and token proof needs it. Unset, those routes answer 403. |
| `OPENSESAME_CONNECT_APP_ORIGINS` | The https origins the app is served from, comma-separated. |

On a deployment with no relay (GitHub Pages), the connector page asks for a
Vercel access token and team instead and uses Connect's API directly. It can
create, edit and authorize connectors that way, but it cannot run the token
proof: that would put a provider token in the page (ADR 0005).

## 2. Seal the management key

Open **Connections › any service**. With no key sealed, the page opens with a
**Vercel Connect** panel: paste the management key and seal it. It lives in
the vault (`config/vercel-connect-auth`), never in plaintext storage.

## 3. Create the connector

Pick the connection method the service offers — **Vercel app** (managed),
**OAuth**, **MCP server** or **API key** — and review the filled-in fields:

- **OAuth, you register the client.** Open the linked developer console,
  create an OAuth app, paste its client ID and secret. After creation the page
  shows the **Redirect URI** Connect uses; register that exact value at the
  provider (copy key beside it).
- **OAuth or MCP where the server registers clients itself** (RFC 7591 or a
  client ID metadata document — Resend, Linear's MCP server, most MCP
  servers): leave the client ID empty and Vercel registers one.
- **Placeholders** (`{domain}` for Okta, Auth0 and Databricks, `{shop}` for
  Shopify, Workday's host and tenant): fill the field and every endpoint that
  uses it follows.
- **API key:** by default each person pastes their own key when they
  authorize (`subjectType: user`); choose **One shared key** to store one.

**Create connector** sends the whole configuration; nothing is created blank.

## 4. Authorize as yourself, then prove the token

On the created connector's page, **User token**:

1. **Authorize as you** opens the provider's consent in a popup, on behalf of
   your principal (`subject: { type: "user", id }`).
2. **Test user token** asks the relay to acquire your token from Connect. The
   relay fingerprints it, calls the service's own read-only verify endpoint
   with it, and shows: subject, `sha256` fingerprint, expiry, scopes, and the
   service's answer (**Token accepted** with the account it names, or the
   refusal status). The token itself never reaches the page.

The CLI equivalent is `vercel connect token <uid>` (it prints the token; the
page does not).

## 5. Grant access

**Access** on the same page grants a person or agent from this vault's
directory the right to use the connector (`use` / `invoke`) until a time.
These are the same `connection` shares Access › Resources lists (ADR 0115).

## What is proven, and where

| Check | Command | Covers |
| --- | --- | --- |
| Every plan × method ends in a person's token | `pnpm --filter @opensesame/pages exec vitest run src/lib/connect-conformance` | 220 paths across 185 services, through the real relay handlers, a schema-strict Connect emulator and a strict OAuth provider emulator; every one confirmed by the service's verify call (Linq and Snowflake, Vercel-only, excepted). Negative controls fail as a provider would. |
| Every real endpoint is live | `pnpm test:connect-preflight` | 47 OAuth authorization servers, 98 MCP servers, 67 API-key verify endpoints; 9 need the customer's own host. |
| The presets agree with the catalog | `pnpm --filter @opensesame/app-core exec vitest run src/lib/connect-presets.test.ts` | Endpoints and client authentication match `catalog.json` wherever both describe a provider; every create body satisfies Vercel's create schema. |
| A live user token | Steps 1–4 above | Needs a person at the provider's consent screen; nothing in the repository can stand in for that. |

Re-pin the registry with `node scripts/release/pin-connect-services.mjs`,
then `pnpm --filter @opensesame/app-core generate:connect` and
`pnpm --filter @opensesame/pages generate:connect`.
