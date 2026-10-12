# Compiled API-key verification contracts

The browser contains **75 API-key provider plans**. Railway has account, workspace
and project credential variants, producing **77 credential profiles** in total.
Four compiled entries (Lithic, Marqeta, Privacy.com and Stripe Issuing) are refused
by product policy. The [audited browser preflight policy](native-browser-preflight-policy.md)
disables another **27 provider IDs / 29 profiles**, including all three Railway variants.
This leaves **44 provider IDs / 44 profiles** admitted by this route policy; **five**
use tenant/key-dependent URLs with untested CORS. The other 39 static profiles have
unauthenticated preflight admission evidence, including Anthropic's required browser
opt-in header. This is not an authenticated-account or operation-success claim.
The table preserves every compiled contract, including unavailable ones, for review.
A successful actual probe proves credential access to that resource; it does not
invent OAuth permissions or an account identity when the provider returns none.
Operator policy, the actual response's CORS and provider permissions still apply.

Required fields are shown; fields marked **private** are sealed, never public parameters.
An optional field may also be needed for your provider tenant. For all fields, use the
provider-specific form and linked setup instructions. **Check access** repeats the actual
compiled probe, including its provider-defined body and verification headers. Those
bodies are compiled, rather than free-form query inputs. API-key disconnect forgets the local key; revoke it at the provider to
invalidate other uses. [Operator guide](native-browser-connectors.md).

| Provider / credential type | Required fields | Credential placement | Real verification request | Browser route | Setup |
| --- | --- | --- | --- | --- | --- |
| AgentMail | api_key **private** | header Authorization / Bearer | GET `https://api.agentmail.to/v0/inboxes` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://console.agentmail.to) |
| Algolia | api_key **private**, application_id | header X-Algolia-API-Key | GET `https://{application_id}-dsn.algolia.net/1/indexes` | CORS untested for tenant/key URL | [Setup](https://dashboard.algolia.com/account/api-keys) |
| Anthropic | api_key **private** | header x-api-key | GET `https://api.anthropic.com/v1/models` | Browser opt-in header required | [Setup](https://platform.claude.com/settings/keys) |
| AssemblyAI | api_key **private**, api_host | header Authorization | GET `https://{api_host}/v2/transcript?limit=1` | Preflight admitted; actual access required | [Setup](https://www.assemblyai.com/app/api-keys) |
| BambooHR | api_key **private**, company_domain | basic | GET `https://{company_domain}.bamboohr.com/api/v1/meta/fields` | CORS untested for tenant/key URL | [Setup](https://{company_domain}.bamboohr.com/settings/permissions/api.php) |
| beehiiv | api_key **private** | header Authorization / Bearer | GET `https://api.beehiiv.com/v2/publications` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://app.beehiiv.com/settings/workspace/api) |
| Brevo | api_key **private** | header api-key | GET `https://api.brevo.com/v3/account` | Preflight admitted; actual access required | [Setup](https://app.brevo.com/settings/keys/api) |
| Buildkite | api_key **private** | header Authorization / Bearer | GET `https://api.buildkite.com/v2/access-token` | Preflight admitted; actual access required | [Setup](https://buildkite.com/user/api-access-tokens) |
| Calendly | api_key **private** | header Authorization / Bearer | GET `https://api.calendly.com/users/me` | Preflight admitted; actual access required | [Setup](https://calendly.com/integrations/api_webhooks) |
| CircleCI | api_key **private** | header Circle-Token | GET `https://circleci.com/api/v2/me` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://app.circleci.com/settings/user/tokens) |
| Clerk | api_key **private** | header Authorization / Bearer | GET `https://api.clerk.com/v1/instance` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://dashboard.clerk.com/last-active?path=api-keys) |
| ClickUp | api_key **private** | header Authorization | GET `https://api.clickup.com/api/v2/user` | Preflight admitted; actual access required | [Setup](https://app.clickup.com/settings/apps) |
| Cloudflare | api_key **private** | header Authorization / Bearer | GET `https://api.cloudflare.com/client/v4/user/tokens/verify` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://dash.cloudflare.com/profile/api-tokens) |
| Cloudflare Origin CA | api_key **private** | header Authorization / Bearer | GET `https://api.cloudflare.com/client/v4/user/tokens/verify` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://dash.cloudflare.com/profile/api-tokens) |
| Cohere | api_key **private** | header Authorization / Bearer | GET `https://api.cohere.com/v1/models` | Preflight admitted; actual access required | [Setup](https://dashboard.cohere.com/api-keys) |
| Contentful | api_key **private** | header Authorization / Bearer | GET `https://api.contentful.com/users/me` | Preflight admitted; actual access required | [Setup](https://app.contentful.com/account/profile/cma_tokens) |
| Crowdin | api_key **private**, organization | header Authorization / Bearer | GET `https://api.crowdin.com/api/v2/user` | Preflight admitted; actual access required | [Setup](https://crowdin.com/settings#api-key) |
| Datadog | api_key **private**, site, application_key **private** | header DD-API-KEY | GET `https://api.{site}/api/v2/validate_keys` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://app.datadoghq.com/organization-settings/api-keys) |
| Deepgram | api_key **private** | header Authorization / Token | GET `https://api.deepgram.com/v1/projects` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://console.deepgram.com/) |
| DeepSeek | api_key **private** | header Authorization / Bearer | GET `https://api.deepseek.com/user/balance` | Preflight admitted; actual access required | [Setup](https://platform.deepseek.com/api_keys) |
| DigitalOcean | api_key **private** | header Authorization / Bearer | GET `https://api.digitalocean.com/v2/account` | Preflight admitted; actual access required | [Setup](https://cloud.digitalocean.com/account/api/tokens) |
| Doppler | api_key **private** | header Authorization / Bearer | GET `https://api.doppler.com/v3/me` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://dashboard.doppler.com/) |
| Dovetail | api_key **private** | header Authorization / Bearer | GET `https://dovetail.com/api/v1/token/info` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://dovetail.com/settings/user/account) |
| ElevenLabs | api_key **private** | header xi-api-key | GET `https://api.elevenlabs.io/v1/user` | Preflight admitted; actual access required | [Setup](https://elevenlabs.io/app/settings/api-keys) |
| Exa | api_key **private** | header x-api-key | GET `https://api.exa.ai/websets/v0/websets` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://dashboard.exa.ai/api-keys) |
| Fathom | api_key **private** | header X-Api-Key | GET `https://api.fathom.ai/external/v1/meetings` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://fathom.video/customize#api-access-header) |
| Firecrawl | api_key **private** | header Authorization / Bearer | GET `https://api.firecrawl.dev/v2/team/credit-usage` | Preflight admitted; actual access required | [Setup](https://www.firecrawl.dev/app/api-keys) |
| Fireworks AI | api_key **private** | header Authorization / Bearer | GET `https://api.fireworks.ai/inference/v1/models` | Preflight admitted; actual access required | [Setup](https://app.fireworks.ai/settings/users/api-keys) |
| GitLab | api_key **private** | header Authorization / Bearer | GET `https://gitlab.com/api/v4/user` | Preflight admitted; actual access required | [Setup](https://gitlab.com/-/user_settings/personal_access_tokens) |
| Google Gemini | api_key **private** | header x-goog-api-key | GET `https://generativelanguage.googleapis.com/v1beta/models` | Preflight admitted; actual access required | [Setup](https://aistudio.google.com/app/apikey) |
| Groq | api_key **private** | header Authorization / Bearer | GET `https://api.groq.com/openai/v1/models` | Preflight admitted; actual access required | [Setup](https://console.groq.com/keys) |
| Honeycomb | api_key **private**, api_host | header X-Honeycomb-Team | GET `https://{api_host}/1/auth` | Preflight admitted; actual access required | [Setup](https://ui.honeycomb.io/) |
| Hugging Face | api_key **private** | header Authorization / Bearer | GET `https://huggingface.co/api/whoami-v2` | Preflight admitted; actual access required | [Setup](https://huggingface.co/settings/tokens) |
| Jev | api_key **private** | header Authorization / Bearer | GET `https://api.typesafe.ai/v1/models` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://console.typesafe.ai/settings/keys) |
| Kernel | api_key **private** | header Authorization / Bearer | GET `https://api.onkernel.com/browsers` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://dashboard.onkernel.com/) |
| LaunchDarkly | api_key **private** | header Authorization | GET `https://app.launchdarkly.com/api/v2/caller-identity` | Preflight admitted; actual access required | [Setup](https://app.launchdarkly.com/settings/authorization) |
| Lemma | api_key **private** | header Authorization / Bearer | GET `https://api.getlemma.com/v0/entities` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://getlemma.com/docs/api-reference/authentication) |
| Linear | api_key **private** | header Authorization | POST `https://api.linear.app/graphql` | Preflight admitted; actual access required | [Setup](https://linear.app/settings/account/security) |
| Lithic **policy unavailable** | api_key **private** | header Authorization | GET `https://api.lithic.com/v1/cards?page_size=1` | Product policy refused | [Setup](https://app.lithic.com/settings) |
| Mailgun | api_key **private**, api_host | basic | GET `https://{api_host}/v3/domains` | Preflight admitted; actual access required | [Setup](https://app.mailgun.com/settings/api_security) |
| Marqeta **policy unavailable** | api_key **private**, admin_access_token **private** | basic | GET `https://sandbox-api.marqeta.com/v3/users?count=1` | Product policy refused | [Setup](https://app.marqeta.com/development) |
| MessageBird | api_key **private** | header Authorization / AccessKey | GET `https://rest.messagebird.com/balance` | Preflight admitted; actual access required | [Setup](https://dashboard.messagebird.com/en/developers/access) |
| Mistral AI | api_key **private** | header Authorization / Bearer | GET `https://api.mistral.ai/v1/models` | Preflight admitted; actual access required | [Setup](https://console.mistral.ai/api-keys) |
| monday.com | api_key **private**, account | header Authorization | POST `https://api.monday.com/v2` | Preflight admitted; actual access required | [Setup](https://monday.com/apps/manage/tokens) |
| n8n | api_key **private**, instance | header X-N8N-API-KEY | GET `https://{instance}.app.n8n.cloud/api/v1/workflows?limit=1` | CORS untested for tenant/key URL | [Setup](https://{instance}.app.n8n.cloud/settings/api) |
| Neon | api_key **private** | header Authorization / Bearer | GET `https://console.neon.tech/api/v2/projects?limit=20` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://console.neon.tech/app/settings/api-keys) |
| Netlify | api_key **private** | header Authorization / Bearer | GET `https://api.netlify.com/api/v1/sites?per_page=20` | Preflight admitted; actual access required | [Setup](https://app.netlify.com/user/applications#personal-access-tokens) |
| NewsAPI | api_key **private** | header X-Api-Key | GET `https://newsapi.org/v2/top-headlines/sources` | Preflight admitted; actual access required | [Setup](https://newsapi.org/account) |
| ngrok | api_key **private** | header Authorization / Bearer | GET `https://api.ngrok.com/api_keys` | Preflight admitted; actual access required | [Setup](https://dashboard.ngrok.com/api-keys) |
| Notion | api_key **private** | header Authorization / Bearer | GET `https://api.notion.com/v1/users/me` | Preflight admitted; actual access required | [Setup](https://www.notion.so/profile/integrations) |
| npm | api_key **private** | header Authorization / Bearer | GET `https://registry.npmjs.org/-/whoami` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://www.npmjs.com/settings/~/tokens) |
| OpenAI | api_key **private** | header Authorization / Bearer | GET `https://api.openai.com/v1/models` | Preflight admitted; actual access required | [Setup](https://platform.openai.com/api-keys) |
| OpenRouter | api_key **private** | header Authorization / Bearer | GET `https://openrouter.ai/api/v1/key` | Preflight admitted; actual access required | [Setup](https://openrouter.ai/settings/keys) |
| PagerDuty | api_key **private** | header Authorization / Token | GET `https://api.pagerduty.com/abilities` | Preflight admitted; actual access required | [Setup](https://docs.pagerduty.com/developer/authentication) |
| Perplexity | api_key **private** | header Authorization / Bearer | GET `https://api.perplexity.ai/v1/models` | Preflight admitted; actual access required | [Setup](https://console.perplexity.ai/project/keys) |
| Pinecone | api_key **private** | header Api-Key | GET `https://api.pinecone.io/indexes` | Preflight admitted; actual access required | [Setup](https://app.pinecone.io/) |
| Postmark | api_key **private** | header X-Postmark-Server-Token | GET `https://api.postmarkapp.com/server` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://account.postmarkapp.com/servers) |
| Privacy.com **policy unavailable** | api_key **private** | header Authorization / api-key | GET `https://api.privacy.com/v1/cards?page_size=1` | Product policy refused | [Setup](https://app.privacy.com/account) |
| Railway / Account token | api_key **private** | header Authorization / Bearer | POST `https://backboard.railway.com/graphql/v2` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://railway.com/account/tokens) |
| Railway / Workspace token | api_key **private**, workspace_id | header Authorization / Bearer | POST `https://backboard.railway.com/graphql/v2` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://railway.com/account/tokens) |
| Railway / Project token | api_key **private** | header Project-Access-Token | POST `https://backboard.railway.com/graphql/v2` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://railway.com/account/tokens) |
| Render | api_key **private** | header Authorization / Bearer | GET `https://api.render.com/v1/owners?limit=20` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://dashboard.render.com/u/settings#api-keys) |
| Replicate | api_key **private** | header Authorization / Bearer | GET `https://api.replicate.com/v1/account` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://replicate.com/account/api-tokens) |
| Resend | api_key **private** | header Authorization / Bearer | GET `https://api.resend.com/domains` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://resend.com/api-keys) |
| Sanity | api_key **private**, project_id | header Authorization / Bearer | GET `https://api.sanity.io/v2021-06-07/users/me` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://www.sanity.io/manage) |
| Segment | api_key **private** | header Authorization / Bearer | GET `https://api.segmentapis.com/` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://app.segment.com/goto-my-workspace/settings/access-management/tokens) |
| SendGrid | api_key **private** | header Authorization / Bearer | GET `https://api.sendgrid.com/v3/scopes` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://app.sendgrid.com/settings/api_keys) |
| Similarweb | api_key **private** | query api_key | GET `https://api.similarweb.com/user-capabilities?api_key={key}` | CORS untested for tenant/key URL | [Setup](https://developers.similarweb.com/docs/check-user-usage) |
| Stability AI | api_key **private** | header Authorization / Bearer | GET `https://api.stability.ai/v1/user/account` | Preflight admitted; actual access required | [Setup](https://platform.stability.ai/account/keys) |
| Stripe Issuing **policy unavailable** | api_key **private** | header Authorization / Bearer | GET `https://api.stripe.com/v1/issuing/cards?limit=1` | Product policy refused | [Setup](https://dashboard.stripe.com/apikeys) |
| Telegram Bot | api_key **private** | path | GET `https://api.telegram.org/bot{key}/getMe` | CORS untested for tenant/key URL | [Setup](https://t.me/BotFather) |
| Tinybird | api_key **private** | header Authorization / Bearer | GET `https://api.tinybird.co/v0/sql?q=SELECT+1` | Preflight admitted; actual access required | [Setup](https://cloud.tinybird.co/tokens) |
| Together AI | api_key **private** | header Authorization / Bearer | GET `https://api.together.xyz/v1/models` | Preflight admitted; actual access required | [Setup](https://api.together.ai/settings/api-keys) |
| Typeform | api_key **private**, api_host | header Authorization / Bearer | GET `https://{api_host}/me` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://admin.typeform.com/user/tokens) |
| Vercel | api_key **private** | header Authorization / Bearer | GET `https://api.vercel.com/v2/user` | Preflight admitted; actual access required | [Setup](https://vercel.com/account/settings/tokens) |
| Webflow | api_key **private** | header Authorization / Bearer | GET `https://api.webflow.com/v2/sites` | Unavailable: [audited preflight](native-browser-preflight-policy.md) | [Setup](https://webflow.com/dashboard) |
| WorkOS | api_key **private** | header Authorization / Bearer | GET `https://api.workos.com/organizations?limit=20` | Preflight admitted; actual access required | [Setup](https://dashboard.workos.com/) |
