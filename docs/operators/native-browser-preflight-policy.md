# Browser preflight admission policy

The browser-only implementation applies `spec/connectors/browser-policy.json` before
credential entry, verification or OAuth minting. This policy is independent of hosted
server connector contracts. There is no relay or retry that sends a key to an unavailable
route. Other supported methods, including MCP, have independent admission contracts.

On **2026-10-09**, read-only HTTPS OPTIONS probes used origin
`https://tyler-r-kendrick.github.io`. They sent only the intended method and header **names**,
with no keys, tokens, cookies or authorization values. TLS certificate verification
was enabled; each request had a 12-second deadline and at most six ran concurrently.
All finite Datadog sites, Typeform regions and Railway credential variants were probed.
The following 38 API rules cover 27 provider IDs / 29 credential profiles. Resend REST
OAuth uses the same denied resource preflight and has a separate method rule.

A successful OPTIONS response alone does not prove authenticated access or CORS on the
actual response. A refusal here is a conservative policy for this exact endpoint/origin
snapshot, not proof that every possible origin, tenant or account policy must fail.
Network failures or proxy 5xx were not classified as provider refusals. None occurred
in this audited set. Official browser prohibitions are linked separately for Typeform
and Replicate. SendGrid documentation explicitly prohibits browser `/v3/mail/send`;
the compiled `/v3/scopes` refusal below is its own observed endpoint evidence.

| Provider / choice | Verification endpoint / method | Required preflight headers | HTTP / Allow-Origin | Source |
| --- | --- | --- | --- | --- |
| AgentMail | `GET https://api.agentmail.to/v0/inboxes` | `authorization` | 404 / absent | [Provider evidence](https://docs.agentmail.to/knowledge-base/getting-api-key) |
| beehiiv | `GET https://api.beehiiv.com/v2/publications` | `authorization` | 200 / absent | [Provider evidence](https://developers.beehiiv.com/welcome/create-an-api-key) |
| CircleCI | `GET https://circleci.com/api/v2/me` | `circle-token` | 200 / absent | [Provider evidence](https://circleci.com/docs/guides/toolkit/managing-api-tokens/) |
| Clerk | `GET https://api.clerk.com/v1/instance` | `authorization` | 401 / absent | [Provider evidence](https://clerk.com/docs/reference/backend-api) |
| Cloudflare | `GET https://api.cloudflare.com/client/v4/user/tokens/verify` | `authorization` | 400 / absent | [Provider evidence](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) |
| Datadog / site=datadoghq.com | `GET https://api.datadoghq.com/api/v2/validate_keys` | `dd-api-key, dd-application-key` | 404 / absent | [Provider evidence](https://docs.datadoghq.com/api/latest/authentication/) |
| Datadog / site=us3.datadoghq.com | `GET https://api.us3.datadoghq.com/api/v2/validate_keys` | `dd-api-key, dd-application-key` | 404 / absent | [Provider evidence](https://docs.datadoghq.com/api/latest/authentication/) |
| Datadog / site=us5.datadoghq.com | `GET https://api.us5.datadoghq.com/api/v2/validate_keys` | `dd-api-key, dd-application-key` | 404 / absent | [Provider evidence](https://docs.datadoghq.com/api/latest/authentication/) |
| Datadog / site=datadoghq.eu | `GET https://api.datadoghq.eu/api/v2/validate_keys` | `dd-api-key, dd-application-key` | 404 / absent | [Provider evidence](https://docs.datadoghq.com/api/latest/authentication/) |
| Datadog / site=ap1.datadoghq.com | `GET https://api.ap1.datadoghq.com/api/v2/validate_keys` | `dd-api-key, dd-application-key` | 404 / absent | [Provider evidence](https://docs.datadoghq.com/api/latest/authentication/) |
| Datadog / site=ap2.datadoghq.com | `GET https://api.ap2.datadoghq.com/api/v2/validate_keys` | `dd-api-key, dd-application-key` | 404 / absent | [Provider evidence](https://docs.datadoghq.com/api/latest/authentication/) |
| Datadog / site=uk1.datadoghq.com | `GET https://api.uk1.datadoghq.com/api/v2/validate_keys` | `dd-api-key, dd-application-key` | 404 / absent | [Provider evidence](https://docs.datadoghq.com/api/latest/authentication/) |
| Datadog / site=ddog-gov.com | `GET https://api.ddog-gov.com/api/v2/validate_keys` | `dd-api-key, dd-application-key` | 404 / absent | [Provider evidence](https://docs.datadoghq.com/api/latest/authentication/) |
| Datadog / site=us2.ddog-gov.com | `GET https://api.us2.ddog-gov.com/api/v2/validate_keys` | `dd-api-key, dd-application-key` | 404 / absent | [Provider evidence](https://docs.datadoghq.com/api/latest/authentication/) |
| Deepgram | `GET https://api.deepgram.com/v1/projects` | `authorization` | 400 / absent | [Provider evidence](https://developers.deepgram.com/docs/create-additional-api-keys) |
| Dovetail | `GET https://dovetail.com/api/v1/token/info` | `authorization` | 401 / absent | [Provider evidence](https://developers.dovetail.com/docs/authorization) |
| Exa | `GET https://api.exa.ai/websets/v0/websets` | `x-api-key` | 204 / absent | [Provider evidence](https://exa.ai/docs/reference/getting-started) |
| Fathom | `GET https://api.fathom.ai/external/v1/meetings` | `x-api-key` | 404 / absent | [Provider evidence](https://developers.fathom.ai/quickstart) |
| Jev | `GET https://api.typesafe.ai/v1/models` | `authorization` | 400 / absent | [Provider evidence](https://docs.typesafe.ai/api) |
| Kernel | `GET https://api.onkernel.com/browsers` | `authorization` | 405 / absent | [Provider evidence](https://www.kernel.sh/auth.md) |
| Lemma | `GET https://api.getlemma.com/v0/entities` | `authorization` | 403 / absent | [Provider evidence](https://getlemma.com/docs/api-reference/authentication) |
| Neon | `GET https://console.neon.tech/api/v2/projects?limit=20` | `authorization` | 204 / absent | [Provider evidence](https://neon.com/docs/manage/api-keys) |
| npm | `GET https://registry.npmjs.org/-/whoami` | `authorization` | 404 / absent | [Provider evidence](https://docs.npmjs.com/creating-and-viewing-access-tokens) |
| Railway / credential_variant=account | `POST https://backboard.railway.com/graphql/v2` | `authorization, content-type` | 204 / https://railway.com | [Provider evidence](https://docs.railway.com/reference/public-api) |
| Railway / credential_variant=workspace | `POST https://backboard.railway.com/graphql/v2` | `authorization, content-type` | 204 / https://railway.com | [Provider evidence](https://docs.railway.com/reference/public-api) |
| Railway / credential_variant=project | `POST https://backboard.railway.com/graphql/v2` | `content-type, project-access-token` | 204 / https://railway.com | [Provider evidence](https://docs.railway.com/reference/public-api) |
| Render | `GET https://api.render.com/v1/owners?limit=20` | `authorization` | 200 / absent | [Provider evidence](https://render.com/docs/api) |
| Replicate | `GET https://api.replicate.com/v1/account` | `authorization` | 200 / absent | [Provider evidence](https://replicate.com/docs/reference/http#accounts.get); [Provider evidence](https://github.com/replicate/replicate-javascript) |
| Resend | `GET https://api.resend.com/domains` | `authorization` | 401 / absent | [Provider evidence](https://resend.com/docs/api-reference/domains/list-domains); [Provider evidence](https://resend.com/docs/guides/building-a-resend-oauth-client) |
| Sanity | `GET https://api.sanity.io/v2021-06-07/users/me` | `authorization` | 204 / absent | [Provider evidence](https://www.sanity.io/docs/content-lake/http-auth) |
| Segment | `GET https://api.segmentapis.com/` | `authorization` | 401 / absent | [Provider evidence](https://docs.segmentapis.com/tag/Getting-Started) |
| SendGrid | `GET https://api.sendgrid.com/v3/scopes` | `authorization` | 200 / absent | [Provider evidence](https://www.twilio.com/docs/sendgrid/api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access); [Provider evidence](https://www.twilio.com/docs/sendgrid/for-developers/sending-email/cors) |
| Typeform / api_host=api.typeform.com | `GET https://api.typeform.com/me` | `authorization` | 200 / absent | [Provider evidence](https://www.typeform.com/developers/get-started/personal-access-token/); [Provider evidence](https://community.typeform.com/typeform-developers-44/help-needed-cors-policy-5899) |
| Typeform / api_host=api.eu.typeform.com | `GET https://api.eu.typeform.com/me` | `authorization` | 200 / absent | [Provider evidence](https://www.typeform.com/developers/get-started/personal-access-token/); [Provider evidence](https://community.typeform.com/typeform-developers-44/help-needed-cors-policy-5899) |
| Webflow | `GET https://api.webflow.com/v2/sites` | `authorization` | 200 / absent | [Provider evidence](https://developers.webflow.com/data/reference/authentication/site-token) |
| Cloudflare Origin CA | `GET https://api.cloudflare.com/client/v4/user/tokens/verify` | `authorization` | 400 / absent | [Provider evidence](https://developers.cloudflare.com/fundamentals/api/get-started/ca-keys/) |
| Doppler | `GET https://api.doppler.com/v3/me` | `authorization` | 204 / https://docs.doppler.com | [Provider evidence](https://docs.doppler.com/reference/api) |
| Postmark | `GET https://api.postmarkapp.com/server` | `x-postmark-server-token` | 200 / absent | [Provider evidence](https://postmarkapp.com/developer/api/overview) |

Notion is **not denied**: its compiled credential preflight admitted the origin, and
[Notion documents direct browser API calls](https://developers.notion.com/guides/get-started/handling-api-keys#calling-the-api-from-a-browser).
Its confidential OAuth exchange remains a different contract. Anthropic requires
`anthropic-dangerous-direct-browser-access: true`: with that compiled verification
header, `/v1/models` returned HTTP 200 and Allow-Origin `*`, admitting `x-api-key`,
`anthropic-version`, the browser opt-in and optional workspace header. Hosted model
requests use the same opt-in. Organization policy may still refuse actual requests.

Algolia, BambooHR, n8n, Similarweb and Telegram have tenant/key-dependent verification
URLs. They were not guessed or tested with credentials and are **not blanket denied**.
Their forms do not imply CORS has been established. Only successful actual verification
creates a verified connection. The [contract table](native-api-key-contracts.md) retains
all 75 compiled provider IDs / 77 profiles with their truthful route dispositions.

To reproduce a rule without credentials, issue OPTIONS to its exact `probe.url` with
`Origin`, `Access-Control-Request-Method` and `Access-Control-Request-Headers` from the
authored source. Require a successful response, matching or wildcard Allow-Origin,
and admission of every required method/header. Keep TLS verification enabled. Update
the authored policy and regenerate it with `node packages/app-core/scripts/emit-browser-policy.mjs`
only after reviewing exact endpoint evidence; its drift test protects the UI/runtime contract.
