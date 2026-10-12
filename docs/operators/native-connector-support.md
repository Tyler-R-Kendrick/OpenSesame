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

Where a provider has no browser connection, its row says why and cites the evidence:
[`spec/connectors/browser-dispositions.json`](../../spec/connectors/browser-dispositions.json)
holds a dated probe of the provider's own servers from the audited origin, or the
documentation that backs a statement ([ADR 0197](../adr/0197-browser-dispositions-and-honest-links.md)).
`pnpm audit:browser-dispositions` re-runs every probe and reports where an answer has moved.
A provider with no authored row is described only by what OpenSesame's own catalog lacks.
The Link column says what its address is: documentation, the provider's website,
fnox's documentation (where fnox is the only source), or MCP server metadata.

| Connector | Browser method or disposition | Requirement / constraint | Link |
| --- | --- | --- | --- |
| 1Password (`1password`) | Companion / export import | This catalog entry configures 1Password's command-line tool (op), which reads items on the computer it runs on. Evidence: [browser-dispositions.json](../../spec/connectors/browser-dispositions.json). | [Docs](https://www.1password.dev/cli) |
| Adobe (`adobe`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://adobe.io) |
| Agentcard (`agentcard`) | Policy unavailable | Payment connection refused; no credentials collected. | [Docs](https://docs.agentcard.sh/tools/mcp) |
| AgentMail (`agentmail`) | MCP DCR | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Docs](https://docs.agentmail.to/knowledge-base/getting-api-key) |
| Airtable (`airtable`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://mcp.airtable.com/.well-known/oauth-protected-resource/mcp) |
| Alchemy (`alchemy`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Docs](https://www.alchemy.com/docs/alchemy-mcp-server) |
| Algolia (`algolia`) | API key | Tenant/key-dependent verification URL was not probed. Browser CORS remains unverified; only a successful actual provider request can establish access. | [Docs](https://www.algolia.com/doc/rest-api/search/) |
| Amazon Bedrock (`aws-bedrock`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Docs](https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started-api.html) |
| Amplitude (`amplitude`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://amplitude.com) |
| Anthropic (`anthropic`) | API key | Compiled browser opt-in header is required. Audited preflight admits it; workspace policy and actual key verification still apply. | [Docs](https://platform.claude.com/docs/en/api/overview) |
| Apple Wallet (`apple-wallet`) | Policy unavailable | No wallet provisioning driver; signing/issuer credentials are not collected. | [Docs](https://developer.apple.com/wallet/) |
| Asana (`asana`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://developers.asana.com/docs/oauth) |
| AssemblyAI (`assemblyai`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://www.assemblyai.com/docs/api-reference/overview/) |
| Attio (`attio`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://attio.com) |
| Auth0 (`auth0`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow) |
| AWeber (`aweber`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.aweber.com/api/api/connecting-and-using-the-aweber-mcp-server) |
| AWS KMS (`aws-kms`) | Existing vault key protection | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.aws.amazon.com/kms/latest/developerguide/overview.html) |
| AWS Parameter Store (`aws-parameter-store`) | API key (SigV4) | Your IAM access key, signed in this browser and sent only to `ssm.<region>.amazonaws.com`. Verification lists the first parameter names; a value is read once on request and never kept. The endpoint is compiled from the region, never typed. | [Docs](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html) |
| AWS Secrets Manager (`aws-secrets-manager`) | API key (SigV4) | Your IAM access key, signed in this browser and sent only to `secretsmanager.<region>.amazonaws.com`. Verification lists the first secret names; a value is read once on request and never kept. The endpoint is compiled from the region, never typed. | [Docs](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html) |
| Axiom (`axiom`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://axiom.co/docs/console/intelligence/mcp-server) |
| Azure App Configuration (`azure-app-configuration`) | Reachable; driver not built | Azure App Configuration answers browser preflights from this site (CORS allows any origin). Evidence: [browser-dispositions.json](../../spec/connectors/browser-dispositions.json). | [Docs](https://learn.microsoft.com/en-us/azure/azure-app-configuration/overview) |
| Azure Key Vault Secrets (`azure-key-vault-secrets`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Docs](https://learn.microsoft.com/en-us/azure/key-vault/secrets/about-secrets) |
| Azure OpenAI (`azure-openai`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Docs](https://learn.microsoft.com/azure/ai-services/openai/reference) |
| BambooHR (`bamboohr`) | API key | Tenant/key-dependent verification URL was not probed. Browser CORS remains unverified; only a successful actual provider request can establish access. | [Docs](https://documentation.bamboohr.com/docs/getting-started) |
| Base44 (`base44`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://github.com/base44/skills/blob/main/skills/base44-remote-dev/SKILL.md) |
| beehiiv (`beehiiv`) | MCP DCR | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Docs](https://developers.beehiiv.com/oauth2) |
| Better Auth (`better-auth`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Docs](https://better-auth.com/docs/plugins/api-key) |
| Better Stack (`better-stack`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://betterstack.com/docs/getting-started/integrations/mcp/) |
| BioRender (`biorender`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Docs](https://help.biorender.com/hc/en-gb/articles/30870978672157-How-to-use-the-BioRender-MCP-connector) |
| Bitbucket (`bitbucket`) | Existing Git backup | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://developer.atlassian.com/cloud/bitbucket/oauth-2/) |
| Bitly (`bitly`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://api-ssl.bitly.com/.well-known/oauth-protected-resource) |
| Bitwarden (`bitwarden`) | Companion / export import | Bitwarden reads vault items through its command-line client. Evidence: [browser-dispositions.json](../../spec/connectors/browser-dispositions.json). | [Docs](https://bitwarden.com/help/bitwarden-apis/) |
| Bitwarden Secrets Manager (`bitwarden-secrets-manager`) | Companion | Bitwarden Secrets Manager is used through its web app, its command-line client or its SDK. Evidence: [browser-dispositions.json](../../spec/connectors/browser-dispositions.json). | [Docs](https://bitwarden.com/help/secrets-manager-overview/) |
| Box (`box`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://developer.box.com/guides/authentication/oauth2/) |
| Brand24 (`brand24`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://help.brand24.com/en/articles/13011375-brand24-mcp) |
| Brevo (`brevo`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://developers.brevo.com/docs/getting-started) |
| Brex (`brex`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://api.brex.com/.well-known/oauth-protected-resource/mcp) |
| Buildkite (`buildkite`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://buildkite.com/docs/apis/rest-api#authentication) |
| Calendly (`calendly`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://developer.calendly.com/docs/authentication/creating-an-oauth-app) |
| Candid (`candid`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://mcp.candid.org/.well-known/oauth-protected-resource/mcp) |
| Canva (`canva`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://www.canva.dev/docs/connect/authentication/) |
| Checkly (`checkly`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://www.checklyhq.com/docs/ai/mcp-server/) |
| CircleCI (`circleci`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://circleci.com/docs/guides/toolkit/managing-api-tokens/) |
| Clay (`clay`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://clay.com) |
| Clerk (`clerk`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://clerk.com/docs/reference/backend-api) |
| ClickHouse (`clickhouse`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://mcp.clickhouse.cloud/.well-known/oauth-protected-resource/mcp) |
| ClickUp (`clickup`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://developer.clickup.com/docs/authentication) |
| Cloudflare (`cloudflare`) | MCP CIMD | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Docs](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) |
| Cloudflare Origin CA (`cloudflare-origin-ca`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://developers.cloudflare.com/fundamentals/api/get-started/ca-keys/) |
| Cloudflare Wallet (`cloudflare-wallet`) | Policy unavailable | No wallet provisioning driver; signing/issuer credentials are not collected. | [Docs](https://developers.cloudflare.com/) |
| Cloudinary (`cloudinary`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://asset-management.mcp.cloudinary.com/.well-known/oauth-protected-resource/sse) |
| Coda (`coda`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://coda.io/.well-known/oauth-protected-resource/apis/mcp) |
| Codeberg (`codeberg`) | Existing Git backup | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://forgejo.org/docs/latest/user/oauth2-provider/) |
| Cohere (`cohere`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.cohere.com/reference/list-models) |
| Common Room (`common-room`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://commonroom.io) |
| Contentful (`contentful`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://www.contentful.com/developers/docs/references/authentication/) |
| Convex (`convex`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://docs.convex.dev/platform-apis/oauth-applications) |
| Coupler.io (`coupler-io`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://blog.coupler.io/how-to-use-coupler-mcp-server/) |
| Crossbeam (`crossbeam`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Docs](https://help.crossbeam.com/en/articles/12601327-crossbeam-mcp-server) |
| Crowdin (`crowdin`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://support.crowdin.com/developer/authorizing-oauth-apps/) |
| Cursor Origin (`origin`) | Existing Git backup | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://cursor.com/docs/api/origin) |
| Databricks (`databricks`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://docs.databricks.com/aws/en/dev-tools/auth/oauth-u2m) |
| Datadog (`datadog`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://docs.datadoghq.com/api/latest/authentication/) |
| Deepgram (`deepgram`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://developers.deepgram.com/docs/create-additional-api-keys) |
| DeepSeek (`deepseek`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://api-docs.deepseek.com/api/get-user-balance) |
| Dex (`dex`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://getdex.com/docs/ai/mcp-server) |
| DigitalOcean (`digitalocean`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.digitalocean.com/reference/api/create-personal-access-token/) |
| Discord (`discord`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://docs.discord.com/developers/topics/oauth2) |
| Docusign (`docusign`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://developers.docusign.com/platform/auth/confidential-authcode-get-token/) |
| Doppler (`doppler`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://docs.doppler.com/reference/api) |
| Dovetail (`dovetail`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://developers.dovetail.com/docs/authorization) |
| Dropbox (`dropbox`) | REST PKCE | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://developers.dropbox.com/oauth-guide) |
| Egnyte (`egnyte`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://mcp-server.egnyte.com/.well-known/oauth-protected-resource) |
| ElevenLabs (`elevenlabs`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://elevenlabs.io/docs/api-reference/authentication) |
| Embat (`embat`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://tellme.embat.io/.well-known/oauth-protected-resource/mcp) |
| Encrypted Remote Store (`encrypted-remote`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [fnox docs](https://fnox.jdx.dev/providers/overview.html) |
| Exa (`exa`) | MCP CIMD | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Docs](https://exa.ai/docs/reference/getting-started) |
| Fathom (`fathom`) | MCP DCR | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Docs](https://developers.fathom.ai/quickstart) |
| Figma (`figma`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://developers.figma.com/docs/rest-api/oauth-apps/) |
| Firecrawl (`firecrawl`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.firecrawl.dev/api-reference/endpoint/credit-usage) |
| Fireflies (`fireflies`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://fireflies.ai) |
| Fireworks AI (`fireworks`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.fireworks.ai/api-reference/introduction) |
| FOKS (`foks`) | Companion / export import | Native application/OS/CLI required. Supported export import creates a local snapshot. | [Website](https://foks.pub/) |
| G2 (`g2`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://mcp.g2.com/.well-known/oauth-protected-resource/mcp) |
| Git (any remote) (`git`) | Existing Git backup | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://git-scm.com/docs/gitcredentials) |
| Gitee (`gitee`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://gitee.com/api/v5/oauth_doc) |
| GitHub (`github`) | Existing GitHub connection / backup | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) |
| GitLab (`gitlab`) | API key; REST PKCE; Existing Git backup | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.gitlab.com/api/oauth2/) |
| Google (`google`) | REST GIS popup | GIS popup unavailable with enforced COOP/COEP; Gemini API keys belong to a separate connector. | [Docs](https://developers.google.com/identity/oauth2/web/guides/use-token-model) |
| Google Cloud KMS (`gcp-kms`) | Existing vault key protection | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.cloud.google.com/kms/docs/key-management-service) |
| Google Cloud Secret Manager (`gcp-secret-manager`) | Reachable; driver not built | Google Cloud Secret Manager's API answers browser requests from this site. Evidence: [browser-dispositions.json](../../spec/connectors/browser-dispositions.json). | [Docs](https://docs.cloud.google.com/secret-manager/docs/overview) |
| Google Gemini (`gemini`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://ai.google.dev/gemini-api/docs/api-key) |
| Google Wallet (`google-wallet`) | Policy unavailable | No wallet provisioning driver; signing/issuer credentials are not collected. | [Docs](https://developers.google.com/wallet) |
| Granola (`granola`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://granola.ai) |
| Groq (`groq`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://console.groq.com/docs/api-reference) |
| Gusto (`gusto`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Website](https://gusto.com) |
| Harmonic (`harmonic`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://support.harmonic.ai/en/articles/12785899-harmonic-mcp-server-getting-started-guide) |
| Harvest (`harvest`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://help.getharvest.com/api-v2/authentication-api/authentication/authentication/) |
| HashiCorp Vault (`vault`) | HTTPS instance token | Your instance must allow the app origin; lookup-self verifies this token. | [Docs](https://developer.hashicorp.com/vault/docs) |
| Honeycomb (`honeycomb`) | MCP CIMD; API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.honeycomb.io/api/auth) |
| HubSpot (`hubspot`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://developers.hubspot.com/docs/guides/apps/authentication/working-with-oauth) |
| Hugging Face (`hugging-face`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://huggingface.co/.well-known/oauth-protected-resource/mcp) |
| Hugging Face (`huggingface`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://huggingface.co/docs/hub/security-tokens) |
| Indeed (`indeed`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://indeed.com) |
| Infisical (`infisical`) | Provider blocks browsers | Infisical Cloud's API answers browsers only on Infisical's own origin, so a page here cannot call it. Evidence: [browser-dispositions.json](../../spec/connectors/browser-dispositions.json). | [Docs](https://infisical.com/docs/documentation/getting-started/introduction) |
| Intercom (`intercom`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://developers.intercom.com/docs/build-an-integration/learn-more/authentication/setting-up-oauth) |
| Intuit Mailchimp (`intuit-mailchimp`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://mailchimp.com) |
| Jev (`jev`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://docs.typesafe.ai/api) |
| Jira (`jira`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) |
| Jotform (`jotform`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://jotform.com) |
| KeePass (`keepass`) | Companion / export import | This catalog entry points at a KeePass database file by path. Evidence: [browser-dispositions.json](../../spec/connectors/browser-dispositions.json). | [Docs](https://keepass.info/help/base/index.html) |
| Kernel (`kernel`) | MCP DCR | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Docs](https://www.kernel.sh/auth.md) |
| LangSmith (`langsmith`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.langchain.com/langsmith/langsmith-remote-mcp) |
| LaunchDarkly (`launchdarkly`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://launchdarkly.com/docs/api) |
| Lemma (`lemma`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://getlemma.com/docs/api-reference/authentication) |
| Linear (`linear`) | Linear API key / app+user PKCE | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://linear.app/developers/oauth-2-0-authentication) |
| LinkedIn (`linkedin`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow) |
| Linq (`linq`) | Browser unavailable | Hosted managed provisioning has no supported public browser contract. | [Docs](https://docs.linqapp.com) |
| Lithic (`lithic`) | Policy unavailable | Payment connection refused; no credentials collected. | [Docs](https://docs.lithic.com/docs/api-basics) |
| Local Falcon (`local-falcon`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://mcp.localfalcon.com/.well-known/oauth-protected-resource) |
| LogRocket (`logrocket`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.logrocket.com/docs/mcp) |
| Lovable (`lovable`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://lovable.dev) |
| Lucid (`lucid`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://lucid.app) |
| Mailgun (`mailgun`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://documentation.mailgun.com/docs/mailgun/api-reference/authentication) |
| Make (`make`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://mcp.make.com/.well-known/oauth-protected-resource) |
| Manufact (`manufact`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://mcp.manufact.com/.well-known/oauth-protected-resource/mcp) |
| Marqeta (`marqeta`) | Policy unavailable | Payment connection refused; no credentials collected. | [Docs](https://www.marqeta.com/docs/developer-guides/core-api-quick-start) |
| Mem0 (`mem0`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://mcp.mem0.ai/.well-known/oauth-protected-resource) |
| MessageBird (`messagebird`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://developers.messagebird.com/api/) |
| Microsoft (`microsoft`) | REST PKCE | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) |
| Microsoft Teams (`microsoft-teams`) | REST PKCE | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) |
| Miro (`miro`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://mcp.miro.com/.well-known/oauth-protected-resource) |
| Mistral AI (`mistral`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.mistral.ai/admin/identity-access/api-keys) |
| Mixpanel (`mixpanel`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://mcp.mixpanel.com/.well-known/oauth-protected-resource/mcp) |
| monday.com (`monday`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://developer.monday.com/apps/docs/migrating-to-the-new-oauth-flow) |
| MotherDuck (`motherduck`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://motherduck.com/docs/key-tasks/ai-and-motherduck/mcp-setup/) |
| n8n (`n8n`) | API key | Tenant/key-dependent verification URL was not probed. Browser CORS remains unverified; only a successful actual provider request can establish access. | [Docs](https://docs.n8n.io/connect/n8n-api/authentication) |
| Neon (`neon`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://neon.com/docs/manage/api-keys) |
| Netlify (`netlify`) | MCP DCR; API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/) |
| New Relic (`new-relic`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.newrelic.com/docs/agentic-ai/mcp/setup/) |
| NewsAPI (`newsapi`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://newsapi.org/docs/authentication) |
| ngrok (`ngrok`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://ngrok.com/docs/api/) |
| Notion (`notion`) | MCP CIMD; API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://developers.notion.com/docs/authorization) |
| npm (`npm`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://docs.npmjs.com/creating-and-viewing-access-tokens) |
| Okta (`okta`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://developer.okta.com/docs/guides/implement-oauth-for-okta/main/) |
| OpenAI (`openai`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://platform.openai.com/docs/api-reference/authentication) |
| OpenBao (`openbao`) | HTTPS instance token | Your instance must allow the app origin; lookup-self verifies this token. | [Docs](https://openbao.org/docs/) |
| OpenRouter (`openrouter`) | API key; REST key PKCE | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://openrouter.ai/docs/guides/overview/auth/oauth) |
| OS Keychain (`keychain`) | Companion | The operating system's keychain can be read only by native code on the machine that owns it. Evidence: [browser-dispositions.json](../../spec/connectors/browser-dispositions.json). | [fnox docs](https://fnox.jdx.dev/providers/keychain.html) |
| Otter.ai (`otter-ai`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://otter.ai) |
| O’Reilly (`oreilly`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://api.oreilly.com/.well-known/oauth-protected-resource/api/content-discovery/v1/mcp) |
| PagerDuty (`pagerduty`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.pagerduty.com/developer/authentication) |
| password-store (`password-store`) | Companion | pass keeps GPG-encrypted files in a directory on your computer, and this catalog entry points at that directory. Evidence: [browser-dispositions.json](../../spec/connectors/browser-dispositions.json). | [Website](https://www.passwordstore.org/) |
| Passwordstate (`passwordstate`) | Browser unavailable | Catalog operations require a native/provider contract absent from this browser; setup remains separate from verified access. | [Website](https://www.clickstudios.com.au/) |
| PayPal (`paypal`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://paypal.com) |
| Pendo (`pendo`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://pendo.io) |
| Perplexity (`perplexity`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.perplexity.ai/docs/admin/api-key-management) |
| Photon (`photon`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://photon.codes/docs/api-reference/oauth) |
| Pinecone (`pinecone`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.pinecone.io/guides/projects/manage-api-keys) |
| PlanetScale (`planetscale`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://mcp.pscale.dev/.well-known/oauth-protected-resource/mcp/planetscale) |
| PostHog (`posthog`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://mcp.posthog.com/.well-known/oauth-protected-resource/mcp) |
| Postman (`postman`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://mcp.postman.com/.well-known/oauth-protected-resource/minimal) |
| Postmark (`postmark`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://postmarkapp.com/developer/api/overview) |
| Privacy.com (`privacy`) | Policy unavailable | Payment connection refused; no credentials collected. | [Docs](https://developers.privacy.com/reference/get_cards-1) |
| Proton Pass (`proton-pass`) | Provider blocks browsers | The Proton Pass endpoint checked (pass.proton.me/api/pass/v1/user/access) answers a browser preflight from this site without CORS headers, so a page here cannot call it. Evidence: [browser-dispositions.json](../../spec/connectors/browser-dispositions.json). | [Docs](https://proton.me/support/pass) |
| Pylon (`pylon`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://support.usepylon.com/articles/2407390554-connecting-to-the-pylon-mcp-server) |
| Quartr (`quartr`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://mcp.quartr.com/docs) |
| Quicknode (`quicknode`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://www.quicknode.com/docs/build-with-ai/quicknode-mcp) |
| Railway (`railway`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://docs.railway.com/reference/public-api) |
| Razorpay (`razorpay`) | Policy unavailable | Payment connection refused; no credentials collected. | [MCP metadata](https://mcp.razorpay.com/.well-known/oauth-protected-resource/mcp) |
| Read AI (`read-ai`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://support.read.ai/hc/en-us/articles/49381158409491-MCP-Server) |
| Readwise (`readwise`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://readwise.io) |
| Reclaim.ai (`reclaim-ai`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Docs](https://help.reclaim.ai/en/articles/15265289-reclaim-2-0-claude-integration) |
| Reddit (`reddit`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://github.com/reddit-archive/reddit/wiki/OAuth2) |
| Render (`render`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://render.com/docs/api) |
| Replicate (`replicate`) | Browser unavailable | API key unavailable: official API disallows direct browser use; compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://replicate.com/docs/reference/http#accounts.get) |
| Resend (`resend`) | MCP CIMD | API key and REST OAuth unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Docs](https://resend.com/docs/guides/building-a-resend-oauth-client) |
| S3-compatible bucket (`s3`) | Existing S3 storage | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html) |
| Salesforce (`salesforce`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_web_server_flow.htm) |
| Samsung Wallet (`samsung-wallet`) | Policy unavailable | No wallet provisioning driver; signing/issuer credentials are not collected. | [Docs](https://developer.samsung.com/wallet) |
| Sanity (`sanity`) | MCP DCR | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Docs](https://www.sanity.io/docs/oauth2) |
| Segment (`segment`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://docs.segmentapis.com/tag/Getting-Started) |
| SendGrid (`sendgrid`) | Browser unavailable | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://www.twilio.com/docs/sendgrid/api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access) |
| Sentry (`sentry`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.sentry.io/api/auth/) |
| Serpstat (`serpstat`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://serpstat.com/page/serpstat-mcp/) |
| Shopify (`shopify`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant) |
| SignNow (`signnow`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://helpcenter.signnow.com/en/articles/14020270-how-to-connect-signnow-to-chatgpt-and-claude) |
| Similarweb (`similarweb`) | API key | Tenant/key-dependent verification URL was not probed. Browser CORS remains unverified; only a successful actual provider request can establish access. | [Docs](https://developers.similarweb.com/docs/check-user-usage) |
| Slack (`slack`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://docs.slack.dev/authentication/installing-with-oauth) |
| Snowflake (`snowflake`) | Browser unavailable | Hosted managed provisioning has no supported public browser contract. | [Docs](https://docs.snowflake.com) |
| Spotify (`spotify`) | REST PKCE | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) |
| Stability AI (`stability`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://platform.stability.ai/docs/api-reference#tag/User/operation/userAccount) |
| Statsig (`statsig`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://statsig.com) |
| Streak (`streak`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://support.streak.com/en/articles/13931874-integrating-streak-with-gemini-claude-chatgpt-and-other-ai-tools) |
| Stripe (`stripe`) | Policy unavailable | Payment connection refused; no credentials collected. | [MCP metadata](https://mcp.stripe.com/.well-known/oauth-protected-resource) |
| Stripe Issuing (`stripe-issuing`) | Policy unavailable | Payment connection refused; no credentials collected. | [Docs](https://docs.stripe.com/issuing) |
| Supabase (`supabase`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp) |
| Superhuman Mail (`superhuman-mail`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [Website](https://superhuman.com) |
| Tailscale (`tailscale`) | Companion | Tailscale device enrollment requires tailscaled and the OpenSesame native daemon, which a browser cannot run; a saved auth key alone would not enroll a device. Evidence: [browser-dispositions.json](../../spec/connectors/browser-dispositions.json). | [Docs](https://tailscale.com/kb/1085/auth-keys) |
| Telegram Bot (`telegram`) | API key | Tenant/key-dependent verification URL was not probed. Browser CORS remains unverified; only a successful actual provider request can establish access. | [Docs](https://core.telegram.org/bots/api#authorizing-your-bot) |
| Ticket Tailor (`ticket-tailor`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://mcp.tickettailor.ai/.well-known/oauth-authorization-server) |
| TickTick (`ticktick`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://mcp.ticktick.com/.well-known/oauth-protected-resource) |
| Tinybird (`tinybird`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://www.tinybird.co/docs/api-reference) |
| Todoist (`todoist`) | MCP CIMD | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://ai.todoist.net/.well-known/oauth-protected-resource/mcp) |
| Together AI (`together`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.together.ai/reference/authentication) |
| Twilio (`twilio`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://www.twilio.com/docs/iam/oauth-apps/org-oauth-apps) |
| Twitch (`twitch`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/) |
| Typeform (`typeform`) | Browser unavailable | API key unavailable: official API disallows direct browser use; compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). No relay is provided. | [Docs](https://www.typeform.com/developers/get-started/applications/) |
| Vantage (`vantage`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Docs](https://github.com/vantage-sh/vantage-mcp-server) |
| Vaultwarden (`vaultwarden`) | Companion / export import | Vaultwarden is a Bitwarden-compatible server, so vault items are reached the way Bitwarden's are: through a Bitwarden client that holds your master key, such as its command-line client. Evidence: [browser-dispositions.json](../../spec/connectors/browser-dispositions.json). | [Docs](https://github.com/dani-garcia/vaultwarden/wiki) |
| Vercel (`vercel`) | API key | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://vercel.com/docs/sign-in-with-vercel/authorization-server-api) |
| Webflow (`webflow`) | MCP DCR | API key unavailable: compiled verification preflight refused the audited origin. [Endpoint evidence](native-browser-preflight-policy.md). Select the independent MCP method. | [Docs](https://developers.webflow.com/data/reference/oauth-app) |
| Whimsical (`whimsical`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://whimsical.com/learn/integrations/mcp) |
| WHOOP (`whoop`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://developer.whoop.com/docs/developing/oauth) |
| Wix (`wix`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://mcp.wix.com/.well-known/oauth-protected-resource/mcp) |
| Workday (`workday`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://doc.workday.com/) |
| WorkOS (`workos`) | API key; REST CIMD PKCE | CIMD requires public HTTPS auth/native-client.json. | [Docs](https://workos.com/docs/authkit/connect/oauth) |
| X (`x`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code) |
| Xero (`xero`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [MCP metadata](https://mcp.xero.com/.well-known/oauth-protected-resource/mcp) |
| Zapier (`zapier`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://mcp.zapier.com/.well-known/oauth-protected-resource/api/v1/connect) |
| Zeplin (`zeplin`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://docs.zeplin.dev/docs/authentication) |
| Zernio (`zernio`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [Docs](https://docs.zernio.com) |
| Zomato (`zomato`) | MCP DCR | Provider CORS, permissions and deployment policy must admit the actual requests. | [MCP metadata](https://mcp-server.zomato.com/.well-known/oauth-protected-resource) |
| Zoom (`zoom`) | Browser unavailable | Compiled OAuth requires a confidential client; select another listed public method if offered. | [Docs](https://developers.zoom.us/docs/integrations/oauth/) |
| ZoomInfo (`zoominfo`) | Browser unavailable | MCP lacks a complete advertised public none/S256/registration contract; no secret exchange in the browser. | [Website](https://zoominfo.com) |

## Model providers with no browser connection

These hosted model providers are in the catalog with an endpoint but have no compiled API-key contract, so the Add sheet cannot open for them ([ADR 0192](../adr/0192-model-keys-and-token-exchange.md)). OpenSesame saves only keys it has proven, so a model list that answers without a key cannot be the proof.

| Provider | Why | Evidence |
| --- | --- | --- |
| Abacus (`abacus`) | No way to check a key | `GET https://routellm.abacus.ai/v1/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| AI21 Labs (`ai21`) | No way to check a key | `GET https://api.ai21.com/studio/v1/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| AIHubMix (`aihubmix`) | No way to check a key | `GET https://aihubmix.com/v1/models` → HTTP 200, allow-origin `https://tyler-r-kendrick.github.io` (2026-10-12) |
| Berget.AI (`berget`) | No way to check a key | `GET https://api.berget.ai/v1/models` → HTTP 200, allow-origin `https://tyler-r-kendrick.github.io` (2026-10-12) |
| Chutes (`chutes`) | No way to check a key | `GET https://llm.chutes.ai/v1/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| Deep Infra (`deepinfra`) | No way to check a key | `GET https://api.deepinfra.com/v1/openai/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| Eden AI (`edenai`) | No way to check a key | `GET https://api.edenai.run/v3/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| Friendli (`friendli`) | Provider blocks browsers | `GET https://api.friendli.ai/serverless/v1/models` → HTTP 200, allow-origin `none` (2026-10-12) |
| Helicone (`helicone`) | Provider blocks browsers | `GET https://ai-gateway.helicone.ai/v1/models` → HTTP 200, allow-origin `none` (2026-10-12) |
| Inception (`inception`) | Provider blocks browsers | `GET https://api.inceptionlabs.ai/v1/models` → HTTP 200, allow-origin `none` (2026-10-12) |
| IO.NET (`io-net`) | Provider blocks browsers | `GET https://api.intelligence.io.solutions/api/v1/models` → HTTP 200, allow-origin `none` (2026-10-12) |
| Kilo Gateway (`kilo`) | Provider blocks browsers | `GET https://api.kilo.ai/api/gateway/models` → HTTP 200, allow-origin `none` (2026-10-12) |
| LLM Gateway (`llmgateway`) | Provider blocks browsers | `GET https://api.llmgateway.io/v1/models` → HTTP 200, allow-origin `none` (2026-10-12) |
| MiniMax (minimax.io) (`minimax`) | Reachable; contract not authored | `GET https://api.minimax.io/anthropic/v1/models` → HTTP 401, allow-origin `*` (2026-10-12) |
| NanoGPT (`nanogpt`) | No way to check a key | `GET https://nano-gpt.com/api/v1/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| NEAR AI Cloud (`nearai`) | No way to check a key | `GET https://cloud-api.near.ai/v1/models` → HTTP 200, allow-origin `https://tyler-r-kendrick.github.io` (2026-10-12) |
| Novita AI (`novita`) | No way to check a key | `GET https://api.novita.ai/openai/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| Nvidia (`nvidia`) | Provider blocks browsers | `GET https://integrate.api.nvidia.com/v1/models` → HTTP 200, allow-origin `none` (2026-10-12) |
| Ollama Cloud (`ollama-cloud`) | Provider blocks browsers | `GET https://ollama.com/v1/models` → HTTP 200, allow-origin `none` (2026-10-12) |
| OpenCode Zen (`opencode-zen`) | No way to check a key | `GET https://opencode.ai/zen/v1/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| OVHcloud AI Endpoints (`ovhcloud`) | No way to check a key | `GET https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| Poe (`poe`) | No way to check a key | `GET https://api.poe.com/v1/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| Requesty (`requesty`) | No way to check a key | `GET https://router.requesty.ai/v1/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| Sarvam AI (`sarvam`) | No way to check a key | `GET https://api.sarvam.ai/v1/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| Synthetic (`synthetic`) | No way to check a key | `GET https://api.synthetic.new/openai/v1/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| Tinfoil (`tinfoil`) | No way to check a key | `GET https://inference.tinfoil.sh/v1/models` → HTTP 200, allow-origin `https://tyler-r-kendrick.github.io` (2026-10-12) |
| Venice AI (`venice`) | No way to check a key | `GET https://api.venice.ai/api/v1/models` → HTTP 200, allow-origin `*` (2026-10-12) |
| Vercel AI Gateway (`vercel-ai-gateway`) | No way to check a key | `GET https://ai-gateway.vercel.sh/v1/models` → HTTP 200, allow-origin `https://tyler-r-kendrick.github.io` (2026-10-12) |
| Vultr (`vultr`) | No way to check a key | `GET https://api.vultrinference.com/v1/models` → HTTP 200, allow-origin `https://tyler-r-kendrick.github.io` (2026-10-12) |
| Z.AI (`zai`) | Reachable; contract not authored | `GET https://api.z.ai/api/paas/v4/models` → HTTP 401, allow-origin `https://tyler-r-kendrick.github.io` (2026-10-12) |
