# Browser connector support matrix

Snapshot of the compiled browser catalog on 2026-10-09: **225 provider identities**, including **160 Add a connection tiles**.
Feature-bound categories route to settings rather than adding duplicate browse tiles.
A listed method is a protocol implementation, subject to provider CORS, current metadata,
operator policy, account permissions and successful live verification. It is not a claim
that a live customer account was tested. [Operator setup](native-browser-connectors.md) explains
authorization, encrypted storage, cleanup and evidence qualification.

Source: `connect-presets.generated.ts`, `native-browser-oauth-profile.ts`, the bundled
device catalog, specialized routes and `native-device-provider-descriptor.ts`. Recheck this
snapshot whenever those contracts change; do not infer support from a catalog badge.
Browser admission also consumes the authored [preflight policy](native-browser-preflight-policy.md):
27 API provider IDs and Resend REST OAuth are unavailable under that audited policy.
Eligible MCP methods remain separate. Five tenant/key-dependent URL contracts are untested.

| Connector | Browser method or disposition | Requirement / constraint | Setup source |
| --- | --- | --- | --- |
| 1Password (`1password`) | Companion / export import | Native application/OS/CLI required. Supported export import creates a local snapshot. | [Setup](https://fnox.jdx.dev/providers/1password.html) |
| Adobe (`adobe`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://adobe.io) |
| Agentcard (`agentcard`) | Policy unavailable | Payment connection refused; no credentials collected. | [Setup](https://docs.agentcard.sh/tools/mcp) |
| AgentMail (`agentmail`) | MCP DCR | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Setup](https://docs.agentmail.to/knowledge-base/getting-api-key) |
| Airtable (`airtable`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mcp.airtable.com/.well-known/oauth-protected-resource/mcp) |
| Alchemy (`alchemy`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://www.alchemy.com/docs/alchemy-mcp-server) |
| Algolia (`algolia`) | API key | Tenant/key-dependent verification URL was not probed. Browser CORS remains unverified; only a successful actual provider request can establish access. | [Setup](https://www.algolia.com/doc/rest-api/search/) |
| Amazon Bedrock (`aws-bedrock`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Setup](https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started-api.html) |
| Amplitude (`amplitude`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://amplitude.com) |
| Anthropic (`anthropic`) | API key | Compiled browser opt-in header is required. Audited preflight admits it; workspace policy and actual key verification still apply. | [Setup](https://platform.claude.com/docs/en/api/overview) |
| Apple Wallet (`apple-wallet`) | Policy unavailable | No wallet provisioning driver; signing/issuer credentials are not collected. | [Setup](https://developer.apple.com/wallet/) |
| Asana (`asana`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://developers.asana.com/docs/oauth) |
| AssemblyAI (`assemblyai`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://www.assemblyai.com/docs/api-reference/overview/) |
| Attio (`attio`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://attio.com) |
| Auth0 (`auth0`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow) |
| AWeber (`aweber`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.aweber.com/api/api/connecting-and-using-the-aweber-mcp-server) |
| AWS KMS (`aws-kms`) | Existing vault key protection | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://fnox.jdx.dev/providers/aws-kms.html) |
| AWS Parameter Store (`aws-parameter-store`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Setup](https://fnox.jdx.dev/providers/aws-ps.html) |
| AWS Secrets Manager (`aws-secrets-manager`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Setup](https://fnox.jdx.dev/providers/aws-sm.html) |
| Axiom (`axiom`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://axiom.co/docs/console/intelligence/mcp-server) |
| Azure App Configuration (`azure-app-configuration`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Setup](https://fnox.jdx.dev/providers/azure-ac.html) |
| Azure Key Vault Secrets (`azure-key-vault-secrets`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Setup](https://fnox.jdx.dev/providers/azure-sm.html) |
| Azure OpenAI (`azure-openai`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Setup](https://learn.microsoft.com/azure/ai-services/openai/reference) |
| BambooHR (`bamboohr`) | API key | Tenant/key-dependent verification URL was not probed. Browser CORS remains unverified; only a successful actual provider request can establish access. | [Setup](https://documentation.bamboohr.com/docs/getting-started) |
| Base44 (`base44`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://github.com/base44/skills/blob/main/skills/base44-remote-dev/SKILL.md) |
| beehiiv (`beehiiv`) | MCP DCR | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Setup](https://developers.beehiiv.com/oauth2) |
| Better Auth (`better-auth`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Setup](https://better-auth.com/docs/plugins/api-key) |
| Better Stack (`better-stack`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://betterstack.com/docs/getting-started/integrations/mcp/) |
| BioRender (`biorender`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://help.biorender.com/hc/en-gb/articles/30870978672157-How-to-use-the-BioRender-MCP-connector) |
| Bitbucket (`bitbucket`) | Existing Git backup | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://developer.atlassian.com/cloud/bitbucket/oauth-2/) |
| Bitly (`bitly`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://api-ssl.bitly.com/.well-known/oauth-protected-resource) |
| Bitwarden (`bitwarden`) | Companion / export import | Native application/OS/CLI required. Supported export import creates a local snapshot. | [Setup](https://fnox.jdx.dev/providers/bitwarden.html) |
| Bitwarden Secrets Manager (`bitwarden-secrets-manager`) | Companion / export import | Native application/OS/CLI required. Supported export import creates a local snapshot. | [Setup](https://fnox.jdx.dev/providers/bitwarden-sm.html) |
| Box (`box`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://developer.box.com/guides/authentication/oauth2/) |
| Brand24 (`brand24`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://help.brand24.com/en/articles/13011375-brand24-mcp) |
| Brevo (`brevo`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://developers.brevo.com/docs/getting-started) |
| Brex (`brex`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://api.brex.com/.well-known/oauth-protected-resource/mcp) |
| Buildkite (`buildkite`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://buildkite.com/docs/apis/rest-api#authentication) |
| Calendly (`calendly`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://developer.calendly.com/docs/authentication/creating-an-oauth-app) |
| Candid (`candid`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://mcp.candid.org/.well-known/oauth-protected-resource/mcp) |
| Canva (`canva`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://www.canva.dev/docs/connect/authentication/) |
| Checkly (`checkly`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://www.checklyhq.com/docs/ai/mcp-server/) |
| CircleCI (`circleci`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://circleci.com/docs/guides/toolkit/managing-api-tokens/) |
| Clay (`clay`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://clay.com) |
| Clerk (`clerk`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://clerk.com/docs/reference/backend-api) |
| ClickHouse (`clickhouse`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mcp.clickhouse.cloud/.well-known/oauth-protected-resource/mcp) |
| ClickUp (`clickup`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://developer.clickup.com/docs/authentication) |
| Cloudflare (`cloudflare`) | MCP CIMD | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Setup](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) |
| Cloudflare Origin CA (`cloudflare-origin-ca`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://developers.cloudflare.com/fundamentals/api/get-started/ca-keys/) |
| Cloudflare Wallet (`cloudflare-wallet`) | Policy unavailable | No wallet provisioning driver; signing/issuer credentials are not collected. | [Setup](https://developers.cloudflare.com/) |
| Cloudinary (`cloudinary`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://asset-management.mcp.cloudinary.com/.well-known/oauth-protected-resource/sse) |
| Coda (`coda`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://coda.io/.well-known/oauth-protected-resource/apis/mcp) |
| Codeberg (`codeberg`) | Existing Git backup | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://forgejo.org/docs/latest/user/oauth2-provider/) |
| Cohere (`cohere`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.cohere.com/reference/list-models) |
| Common Room (`common-room`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://commonroom.io) |
| Contentful (`contentful`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://www.contentful.com/developers/docs/references/authentication/) |
| Convex (`convex`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://docs.convex.dev/platform-apis/oauth-applications) |
| Coupler.io (`coupler-io`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://blog.coupler.io/how-to-use-coupler-mcp-server/) |
| Crossbeam (`crossbeam`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://help.crossbeam.com/en/articles/12601327-crossbeam-mcp-server) |
| Crowdin (`crowdin`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://support.crowdin.com/developer/authorizing-oauth-apps/) |
| Cursor Origin (`origin`) | Existing Git backup | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://cursor.com/docs/api/origin) |
| Databricks (`databricks`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://docs.databricks.com/aws/en/dev-tools/auth/oauth-u2m) |
| Datadog (`datadog`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://docs.datadoghq.com/api/latest/authentication/) |
| Deepgram (`deepgram`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://developers.deepgram.com/docs/create-additional-api-keys) |
| DeepSeek (`deepseek`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://api-docs.deepseek.com/api/get-user-balance) |
| Dex (`dex`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://getdex.com/docs/ai/mcp-server) |
| DigitalOcean (`digitalocean`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.digitalocean.com/reference/api/create-personal-access-token/) |
| Discord (`discord`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://docs.discord.com/developers/topics/oauth2) |
| Docusign (`docusign`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://developers.docusign.com/platform/auth/confidential-authcode-get-token/) |
| Doppler (`doppler`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://docs.doppler.com/reference/api) |
| Dovetail (`dovetail`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://developers.dovetail.com/docs/authorization) |
| Dropbox (`dropbox`) | REST PKCE | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://developers.dropbox.com/oauth-guide) |
| Egnyte (`egnyte`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://mcp-server.egnyte.com/.well-known/oauth-protected-resource) |
| ElevenLabs (`elevenlabs`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://elevenlabs.io/docs/api-reference/authentication) |
| Embat (`embat`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://tellme.embat.io/.well-known/oauth-protected-resource/mcp) |
| Encrypted Remote Store (`encrypted-remote`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Setup](https://fnox.jdx.dev/providers/overview.html) |
| Exa (`exa`) | MCP CIMD | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Setup](https://exa.ai/docs/reference/getting-started) |
| Fathom (`fathom`) | MCP DCR | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Setup](https://developers.fathom.ai/quickstart) |
| Figma (`figma`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://developers.figma.com/docs/rest-api/oauth-apps/) |
| Firecrawl (`firecrawl`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.firecrawl.dev/api-reference/endpoint/credit-usage) |
| Fireflies (`fireflies`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://fireflies.ai) |
| Fireworks AI (`fireworks`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.fireworks.ai/api-reference/introduction) |
| FOKS (`foks`) | Companion / export import | Native application/OS/CLI required. Supported export import creates a local snapshot. | [Setup](https://fnox.jdx.dev/providers/foks.html) |
| G2 (`g2`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://mcp.g2.com/.well-known/oauth-protected-resource/mcp) |
| Git (any remote) (`git`) | Existing Git backup | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://git-scm.com/docs/gitcredentials) |
| Gitee (`gitee`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://gitee.com/api/v5/oauth_doc) |
| GitHub (`github`) | Existing GitHub connection / backup | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) |
| GitLab (`gitlab`) | API key; REST PKCE; Existing Git backup | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.gitlab.com/api/oauth2/) |
| Google (`google`) | REST GIS popup | GIS popup unavailable with enforced COOP/COEP; Gemini API keys belong to a separate connector. | [Setup](https://developers.google.com/identity/oauth2/web/guides/use-token-model) |
| Google Cloud KMS (`gcp-kms`) | Existing vault key protection | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://fnox.jdx.dev/providers/gcp-kms.html) |
| Google Cloud Secret Manager (`gcp-secret-manager`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Setup](https://fnox.jdx.dev/providers/gcp-sm.html) |
| Google Gemini (`gemini`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://ai.google.dev/gemini-api/docs/api-key) |
| Google Wallet (`google-wallet`) | Policy unavailable | No wallet provisioning driver; signing/issuer credentials are not collected. | [Setup](https://developers.google.com/wallet) |
| Granola (`granola`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://granola.ai) |
| Groq (`groq`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://console.groq.com/docs/api-reference) |
| Gusto (`gusto`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://gusto.com) |
| Harmonic (`harmonic`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://support.harmonic.ai/en/articles/12785899-harmonic-mcp-server-getting-started-guide) |
| Harvest (`harvest`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://help.getharvest.com/api-v2/authentication-api/authentication/authentication/) |
| HashiCorp Vault (`vault`) | HTTPS instance token | Your instance must allow the app origin; lookup-self verifies this token. | [Setup](https://fnox.jdx.dev/providers/vault.html) |
| Honeycomb (`honeycomb`) | MCP CIMD; API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.honeycomb.io/api/auth) |
| HubSpot (`hubspot`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://developers.hubspot.com/docs/guides/apps/authentication/working-with-oauth) |
| Hugging Face (`hugging-face`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://huggingface.co/.well-known/oauth-protected-resource/mcp) |
| Hugging Face (`huggingface`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://huggingface.co/docs/hub/security-tokens) |
| Indeed (`indeed`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://indeed.com) |
| Infisical (`infisical`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Setup](https://fnox.jdx.dev/providers/infisical.html) |
| Intercom (`intercom`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://developers.intercom.com/docs/build-an-integration/learn-more/authentication/setting-up-oauth) |
| Intuit Mailchimp (`intuit-mailchimp`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mailchimp.com) |
| Jev (`jev`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://docs.typesafe.ai/api) |
| Jira (`jira`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) |
| Jotform (`jotform`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://jotform.com) |
| KeePass (`keepass`) | Companion / export import | Native application/OS/CLI required. Supported export import creates a local snapshot. | [Setup](https://fnox.jdx.dev/providers/keepass.html) |
| Kernel (`kernel`) | MCP DCR | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Setup](https://www.kernel.sh/auth.md) |
| LangSmith (`langsmith`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.langchain.com/langsmith/langsmith-remote-mcp) |
| LaunchDarkly (`launchdarkly`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://launchdarkly.com/docs/api) |
| Lemma (`lemma`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://getlemma.com/docs/api-reference/authentication) |
| Linear (`linear`) | Linear API key / app+user PKCE | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://linear.app/developers/oauth-2-0-authentication) |
| LinkedIn (`linkedin`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow) |
| Linq (`linq`) | Browser unavailable | Hosted managed provisioning has no supported public browser contract. | [Setup](https://docs.linqapp.com) |
| Lithic (`lithic`) | Policy unavailable | Payment connection refused; no credentials collected. | [Setup](https://docs.lithic.com/docs/api-basics) |
| Local Falcon (`local-falcon`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mcp.localfalcon.com/.well-known/oauth-protected-resource) |
| LogRocket (`logrocket`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.logrocket.com/docs/mcp) |
| Lovable (`lovable`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://lovable.dev) |
| Lucid (`lucid`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://lucid.app) |
| Mailgun (`mailgun`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://documentation.mailgun.com/docs/mailgun/api-reference/authentication) |
| Make (`make`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://mcp.make.com/.well-known/oauth-protected-resource) |
| Manufact (`manufact`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mcp.manufact.com/.well-known/oauth-protected-resource/mcp) |
| Marqeta (`marqeta`) | Policy unavailable | Payment connection refused; no credentials collected. | [Setup](https://www.marqeta.com/docs/developer-guides/core-api-quick-start) |
| Mem0 (`mem0`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://mcp.mem0.ai/.well-known/oauth-protected-resource) |
| MessageBird (`messagebird`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://developers.messagebird.com/api/) |
| Microsoft (`microsoft`) | REST PKCE | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) |
| Microsoft Teams (`microsoft-teams`) | REST PKCE | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) |
| Miro (`miro`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://mcp.miro.com/.well-known/oauth-protected-resource) |
| Mistral AI (`mistral`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.mistral.ai/admin/identity-access/api-keys) |
| Mixpanel (`mixpanel`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mcp.mixpanel.com/.well-known/oauth-protected-resource/mcp) |
| monday.com (`monday`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://developer.monday.com/apps/docs/migrating-to-the-new-oauth-flow) |
| MotherDuck (`motherduck`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://motherduck.com/docs/key-tasks/ai-and-motherduck/mcp-setup/) |
| n8n (`n8n`) | API key | Tenant/key-dependent verification URL was not probed. Browser CORS remains unverified; only a successful actual provider request can establish access. | [Setup](https://docs.n8n.io/connect/n8n-api/authentication) |
| Neon (`neon`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://neon.com/docs/manage/api-keys) |
| Netlify (`netlify`) | MCP DCR; API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/) |
| New Relic (`new-relic`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.newrelic.com/docs/agentic-ai/mcp/setup/) |
| NewsAPI (`newsapi`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://newsapi.org/docs/authentication) |
| ngrok (`ngrok`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://ngrok.com/docs/api/) |
| Notion (`notion`) | MCP CIMD; API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://developers.notion.com/docs/authorization) |
| npm (`npm`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://docs.npmjs.com/creating-and-viewing-access-tokens) |
| Okta (`okta`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://developer.okta.com/docs/guides/implement-oauth-for-okta/main/) |
| OpenAI (`openai`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://platform.openai.com/docs/api-reference/authentication) |
| OpenBao (`openbao`) | HTTPS instance token | Your instance must allow the app origin; lookup-self verifies this token. | [Setup](https://fnox.jdx.dev/providers/openbao.html) |
| OpenRouter (`openrouter`) | API key; REST key PKCE | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://openrouter.ai/docs/guides/overview/auth/oauth) |
| OS Keychain (`keychain`) | Companion / export import | Native application/OS/CLI required. Supported export import creates a local snapshot. | [Setup](https://fnox.jdx.dev/providers/keychain.html) |
| Otter.ai (`otter-ai`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://otter.ai) |
| O’Reilly (`oreilly`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://api.oreilly.com/.well-known/oauth-protected-resource/api/content-discovery/v1/mcp) |
| PagerDuty (`pagerduty`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.pagerduty.com/developer/authentication) |
| password-store (`password-store`) | Companion / export import | Native application/OS/CLI required. Supported export import creates a local snapshot. | [Setup](https://fnox.jdx.dev/providers/password-store.html) |
| Passwordstate (`passwordstate`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Setup](https://fnox.jdx.dev/cli/provider/add) |
| PayPal (`paypal`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://paypal.com) |
| Pendo (`pendo`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://pendo.io) |
| Perplexity (`perplexity`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.perplexity.ai/docs/admin/api-key-management) |
| Photon (`photon`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://photon.codes/docs/api-reference/oauth) |
| Pinecone (`pinecone`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.pinecone.io/guides/projects/manage-api-keys) |
| PlanetScale (`planetscale`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://mcp.pscale.dev/.well-known/oauth-protected-resource/mcp/planetscale) |
| PostHog (`posthog`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mcp.posthog.com/.well-known/oauth-protected-resource/mcp) |
| Postman (`postman`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mcp.postman.com/.well-known/oauth-protected-resource/minimal) |
| Postmark (`postmark`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://postmarkapp.com/developer/api/overview) |
| Privacy.com (`privacy`) | Policy unavailable | Payment connection refused; no credentials collected. | [Setup](https://developers.privacy.com/reference/get_cards-1) |
| Proton Pass (`proton-pass`) | Companion / export import | Native application/OS/CLI required. Supported export import creates a local snapshot. | [Setup](https://fnox.jdx.dev/providers/proton-pass.html) |
| Pylon (`pylon`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://support.usepylon.com/articles/2407390554-connecting-to-the-pylon-mcp-server) |
| Quartr (`quartr`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mcp.quartr.com/docs) |
| Quicknode (`quicknode`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://www.quicknode.com/docs/build-with-ai/quicknode-mcp) |
| Railway (`railway`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://docs.railway.com/reference/public-api) |
| Razorpay (`razorpay`) | Policy unavailable | Payment connection refused; no credentials collected. | [Setup](https://mcp.razorpay.com/.well-known/oauth-protected-resource/mcp) |
| Read AI (`read-ai`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://support.read.ai/hc/en-us/articles/49381158409491-MCP-Server) |
| Readwise (`readwise`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://readwise.io) |
| Reclaim.ai (`reclaim-ai`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://help.reclaim.ai/en/articles/15265289-reclaim-2-0-claude-integration) |
| Reddit (`reddit`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://github.com/reddit-archive/reddit/wiki/OAuth2) |
| Render (`render`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://render.com/docs/api) |
| Replicate (`replicate`) | Browser unavailable | API key unavailable: official API disallows direct browser use; compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://replicate.com/docs/reference/http#accounts.get) |
| Resend (`resend`) | MCP CIMD | API key and REST OAuth unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Setup](https://resend.com/docs/guides/building-a-resend-oauth-client) |
| S3-compatible bucket (`s3`) | Existing S3 storage | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html) |
| Salesforce (`salesforce`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_web_server_flow.htm) |
| Samsung Wallet (`samsung-wallet`) | Policy unavailable | No wallet provisioning driver; signing/issuer credentials are not collected. | [Setup](https://developer.samsung.com/wallet) |
| Sanity (`sanity`) | MCP DCR | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Setup](https://www.sanity.io/docs/oauth2) |
| Segment (`segment`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://docs.segmentapis.com/tag/Getting-Started) |
| SendGrid (`sendgrid`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://www.twilio.com/docs/sendgrid/api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access) |
| Sentry (`sentry`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.sentry.io/api/auth/) |
| Serpstat (`serpstat`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://serpstat.com/page/serpstat-mcp/) |
| Shopify (`shopify`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant) |
| SignNow (`signnow`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://helpcenter.signnow.com/en/articles/14020270-how-to-connect-signnow-to-chatgpt-and-claude) |
| Similarweb (`similarweb`) | API key | Tenant/key-dependent verification URL was not probed. Browser CORS remains unverified; only a successful actual provider request can establish access. | [Setup](https://developers.similarweb.com/docs/check-user-usage) |
| Slack (`slack`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://docs.slack.dev/authentication/installing-with-oauth) |
| Snowflake (`snowflake`) | Browser unavailable | Hosted managed provisioning has no supported public browser contract. | [Setup](https://docs.snowflake.com) |
| Spotify (`spotify`) | REST PKCE | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) |
| Stability AI (`stability`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://platform.stability.ai/docs/api-reference#tag/User/operation/userAccount) |
| Statsig (`statsig`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://statsig.com) |
| Streak (`streak`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://support.streak.com/en/articles/13931874-integrating-streak-with-gemini-claude-chatgpt-and-other-ai-tools) |
| Stripe (`stripe`) | Policy unavailable | Payment connection refused; no credentials collected. | [Setup](https://mcp.stripe.com/.well-known/oauth-protected-resource) |
| Stripe Issuing (`stripe-issuing`) | Policy unavailable | Payment connection refused; no credentials collected. | [Setup](https://docs.stripe.com/issuing) |
| Supabase (`supabase`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp) |
| Superhuman Mail (`superhuman-mail`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://superhuman.com) |
| Tailscale (`tailscale`) | Native daemon required | Enroll with tailscaled and pair the OpenSesame daemon; saving a key would not enroll a device. | [Setup](https://tailscale.com/kb/1085/auth-keys) |
| Telegram Bot (`telegram`) | API key | Tenant/key-dependent verification URL was not probed. Browser CORS remains unverified; only a successful actual provider request can establish access. | [Setup](https://core.telegram.org/bots/api#authorizing-your-bot) |
| Ticket Tailor (`ticket-tailor`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://mcp.tickettailor.ai/.well-known/oauth-authorization-server) |
| TickTick (`ticktick`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mcp.ticktick.com/.well-known/oauth-protected-resource) |
| Tinybird (`tinybird`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://www.tinybird.co/docs/api-reference) |
| Todoist (`todoist`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://ai.todoist.net/.well-known/oauth-protected-resource/mcp) |
| Together AI (`together`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.together.ai/reference/authentication) |
| Twilio (`twilio`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://www.twilio.com/docs/iam/oauth-apps/org-oauth-apps) |
| Twitch (`twitch`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/) |
| Typeform (`typeform`) | Browser unavailable | API key unavailable: official API disallows direct browser use; compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Setup](https://www.typeform.com/developers/get-started/applications/) |
| Vantage (`vantage`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://github.com/vantage-sh/vantage-mcp-server) |
| Vaultwarden (`vaultwarden`) | Companion / export import | Native application/OS/CLI required. Supported export import creates a local snapshot. | [Setup](https://fnox.jdx.dev/providers/vaultwarden.html) |
| Vercel (`vercel`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://vercel.com/docs/sign-in-with-vercel/authorization-server-api) |
| Webflow (`webflow`) | MCP DCR | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Setup](https://developers.webflow.com/data/reference/oauth-app) |
| Whimsical (`whimsical`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://whimsical.com/learn/integrations/mcp) |
| WHOOP (`whoop`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://developer.whoop.com/docs/developing/oauth) |
| Wix (`wix`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mcp.wix.com/.well-known/oauth-protected-resource/mcp) |
| Workday (`workday`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://doc.workday.com/) |
| WorkOS (`workos`) | API key; REST CIMD PKCE | CIMD requires public HTTPS auth/native-client.json. | [Setup](https://workos.com/docs/authkit/connect/oauth) |
| X (`x`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code) |
| Xero (`xero`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://mcp.xero.com/.well-known/oauth-protected-resource/mcp) |
| Zapier (`zapier`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mcp.zapier.com/.well-known/oauth-protected-resource/api/v1/connect) |
| Zeplin (`zeplin`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://docs.zeplin.dev/docs/authentication) |
| Zernio (`zernio`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://docs.zernio.com) |
| Zomato (`zomato`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Setup](https://mcp-server.zomato.com/.well-known/oauth-protected-resource) |
| Zoom (`zoom`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Setup](https://developers.zoom.us/docs/integrations/oauth/) |
| ZoomInfo (`zoominfo`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Setup](https://zoominfo.com) |
