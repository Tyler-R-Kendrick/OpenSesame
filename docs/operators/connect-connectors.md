# Configure self-hosted connectors

The Connections page uses the configuration pattern of Vercel Connect while
keeping connector configuration on your device. You can serve Pages from your
own origin or use its static build. Creating a local connector requires no
Vercel account, access token, team or project.

Provider endpoints, authentication settings and OAuth scope descriptions
come from [`spec/connectors/connect-presets.json`](../../spec/connectors/connect-presets.json)
through the connector plans. Optional form fields and provider-specific
defaults come from
[`self-hosted-config.json`](../../spec/connectors/self-hosted-config.json).
See [ADR 0183](../adr/0183-self-hosted-connector-configuration.md).

## Configure Linear

1. Unlock your vault and open **Connections › Add a connection › Linear**.
2. Choose **Managed** for a provider application owned by your deployment,
   or **Bring Your Own** for an application you register yourself. Managed
   does not supply a Vercel-owned application or create a Linear OAuth app.
   A self-hosted deployment must provide its own application credentials.
3. Enter your Linear workspace name or ID and the connector name. Workspace
   suggestions, where present, come from your saved local configurations;
   they are not a list discovered from Linear.
4. Review **App Scopes**, **User Scopes** and **Webhook Resource Types**.
   Initial selections match the supplied configuration reference: four app
   scopes (`read`, `write`, `issues:create`, `comments:create`), two user
   scopes (`read`, `write`) and two webhook resources (`Issue`, `Comment`).
   You can narrow the selected permissions. These are product configuration
   defaults, not provider-recommended defaults or permissions granted by
   Linear. Linear's OAuth default is `read`.
5. Review the application settings for the selected method. For your own
   OAuth client, register an application in
   [Linear's developer settings](https://linear.app/settings/api/applications/new).
   Supply your client ID and secret, and use the callback URL supported by
   the authority that will run authorization.
6. Optionally choose an icon and press **Create connector**. Reopen the row
   to review or update its saved configuration.

Linear's [OAuth documentation](https://linear.app/developers/oauth-2-0-authentication)
defines the scope vocabulary and distinguishes user and app actors. Its
[webhook documentation](https://linear.app/developers/webhooks) explicitly
lists `Comment`, `Issue`, `IssueLabel`, `Project`, `Cycle` and `Reaction`
as resource type identifiers. Form selections are saved intent; saving does
not register a webhook. Linear requires a workspace admin or an application
with `admin` scope to create or read webhooks. The form does not request
`admin` by default. These source pages were checked on 2026-10-08.

## Storage and status

Local configuration and credentials commit together in an encrypted device
record. Public row readers and saved form drafts exclude client secrets and
API keys. A blank secret on an edit preserves the stored credential only for
the same application and method. Existing device records remain readable.

Create and Save wait for the configured storage backend to finish before
clearing credentials from the form or reporting success. A failed write
shows an error and keeps the draft for retry. Configuration and its credential
cannot be split by a crash between writes. Saves serialize and refresh records
under a browser lock so concurrent tabs do not overwrite each other. Removal
also waits for storage and masks legacy copies to prevent reload resurrection.
When the storage backend is memory-only, the success
message says the configuration is kept for this session; persistence across
a reload is not claimed.

A configured connector remains **pending**, with the detail
**Configured on this device; authorization required** and no granted scopes.
Create saves configuration. It does not perform provider consent, exchange
an OAuth code, validate an API key or prove a usable token. Complete those
steps through the authority that will invoke the provider before treating
the connector as authorized. This local flow makes no hosted Connect API
request.

## Optional Vercel relay

The legacy Vercel relay is an optional integration described in
[ADR 0127](../adr/0127-connect-callback-backend.md) and
[ADR 0147](../adr/0147-connector-plans-and-user-token-proof.md).
Its deployment variables (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, optional
`VERCEL_PROJECT_ID`, `OPENSESAME_CONNECT_MANAGE_KEY` and
`OPENSESAME_CONNECT_APP_ORIGINS`) belong to that integration. They are not
prerequisites for configuring Linear or another local connector.

## Verification

`packages/app-core/src/lib/self-hosted-config.test.ts` validates Linear
fields and default selections, derives scope choices from every connector
plan, rejects unknown providers and unsupported defaults, and checks that
editing one form cannot mutate source metadata. This verifies local
configuration behavior; live provider consent requires a provider app and
a person who can authorize it.
