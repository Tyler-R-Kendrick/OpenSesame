# Configure self-hosted connectors

The Connections page follows the Vercel Connect configuration experience while
keeping your connectors on your device. A static, self-hosted deployment can
connect Linear directly; no Vercel account, token, team, project or relay is needed.
Provider-specific API-key, public REST OAuth and MCP methods also execute
directly in the browser; see [the browser connector guide](native-browser-connectors.md)
and [all 225 catalog dispositions](native-connector-support.md). Methods requiring
confidential clients or native tooling show their constraints explicitly.

## Connect Linear

1. Unlock your vault and open **Connections › Add a connection › Linear**.
2. Choose **Managed** for your deployment's registered Linear application,
   or **Bring Your Own** for your own OAuth application or API key.
3. Enter a connector name. The optional expected workspace accepts a Linear
   organization name, URL key or ID. Linear's API must confirm it; app and
   user authorizations must belong to the same workspace.
4. For OAuth, review **App Scopes** and **User Scopes** and enter your registered
   **Linear OAuth client ID** if the deployment has not provided one. Register
   the exact displayed **Redirect URI** in
   [Linear developer settings](https://linear.app/settings/api/applications/new).
   The browser uses S256 PKCE; do not enter or publish a client secret.
5. Press **Create and authorize Linear** and complete Linear's consent screen. App scopes
   authorize `actor=app`; selected user scopes require a second consent with
   `actor=user`. Clear one actor's scopes if you do not need that actor. Linear
   always includes `read`. The form's initial four app and two user selections
   are product defaults, not evidence of provider grants.
6. Alternatively, choose **Bring Your Own › API key**, supply a personal key,
   and press **Verify and connect Linear**. The app verifies its account and
   workspace through Linear before reporting success. Specific key permissions
   are managed in Linear, not represented as OAuth scopes.
7. The verified summary shows the actual account, workspace ID, granted scopes
   and expiry. **Use Linear** reads recent issues/projects, lists accessible
   teams, and creates an issue in the selected team. OAuth app and user actors
   are selectable. Results and failures are awaited and displayed.

The connector name and optional icon identify the local connection. They do
not create or rename an OAuth application in Linear's developer console.

### Provision a deployment-owned application

Create a Linear OAuth application and register the deployment's displayed
callback, for example:

```text
https://your.example/OpenSesame/auth/linear.html
```

Serve the public client ID in `os-runtime-config.json` beside the bundle:

```json
{ "linearClientId": "your-registered-public-client-id" }
```

`PAGES_LINEAR_CLIENT_ID` is accepted by `apps/pages/scripts/write-runtime-config.mjs`.
GitHub Pages' deployment workflow reads the repository variable of that name.
This is a public application identifier, never a client secret. Deploy the
secondary `auth/linear.html` document with the static build. Its callback
parameters are distinct from OpenSesame identity sign-in.

OAuth consent redirects require durable browser storage so encrypted pending
state and the verifier survive navigation. If browser storage is unavailable,
use an API key in the explicitly session-only connection rather than attempting
an OAuth redirect that loses its state.

### Register a webhook

Enable **Register a Linear webhook**, provide your HTTPS delivery URL and
select resource types. OAuth requires `admin` in **App Scopes**; a personal key
requires workspace administration rights. The app does not request `admin`
by default. Linear must confirm an enabled subscription before setup completes.

Use **Copy webhook signing secret** in the verified summary to configure your
receiver. The secret never appears in the page or public connection data; the
existing clipboard clearing preference applies. Your receiver should verify
Linear's `Linear-Signature` header using this secret before processing events,
as described in [Linear's webhook documentation](https://linear.app/developers/webhooks).
The browser registers the webhook; your supplied receiver processes deliveries.

A durable UUID and signing-secret intent precede provider creation. A lost
response or failed completion save remains retryable: saving again reconciles
that exact subscription rather than creating duplicates. Changing or disabling
webhooks removes the previous provider subscription. Deletion retries verify
that the subscription is absent before clearing its local record.

If an old credential expires or is revoked, **Reconnect application** obtains
fresh consent before reconciling its webhook. Recovery stays bound to the
original Linear workspace and the connection remains pending until cleanup
and the requested setup are durable. **Retry webhook setup** resumes a failed
provider request. Cleanup can request temporary app `admin` permission; when
that permission was not selected, a second consent restores the selected
app scopes before activation; selecting no app scopes instead revokes the
temporary app grant. Copy the latest signing secret into your receiver
after a webhook is replaced.

A replacement API key is verified against the original workspace before it
can remove the old subscription. You can therefore replace a revoked key
without requiring the revoked key to perform cleanup.

## Storage, edits and disconnect

Configuration, provider identities and credentials commit together in an
atomic encrypted device record. Public readers and saved form drafts never
include API keys, access tokens, refresh tokens or webhook signing secrets.
Storage failure retains the draft and reports an error. Browser locks and a
full-record comparison prevent concurrent tabs from overwriting edits.

Safe name/icon edits preserve authorization. Changing an actor's selected
scope set revokes its old grant and requires new consent, including when
permissions are narrowed. Changing OAuth applications or methods requires
removing the existing connector first. Blank API-key edits reuse the compatible
sealed key and verify it again against Linear.

Before an operation uses an expiring OAuth token, refresh it and persist the
rotated token pair. Reduced permissions or invalid authorization require
reconnection. Requests use fixed Linear endpoints and only the selected
actor's access token; client secrets and refresh tokens are not API headers.

Disconnect removes the registered webhook and revokes OAuth access/refresh
grants before removing their encrypted records. Completed actor cleanup is
saved so a partial failure can be retried. A person-supplied API key is removed
from this device; delete that key in Linear if you also want to invalidate it
for every application using it.

Rejected or rotated OAuth credentials remain in an encrypted cleanup queue
until revocation succeeds. Reconnecting retries that cleanup. If the actor's
scopes have been removed, **Retry authorization cleanup** completes it without
requesting unwanted consent. Concurrent edits and new authorizations prevent
disconnect from forgetting credentials that have not been revoked.

## Optional Vercel relay

Imported Vercel connections keep their existing hosted management and token
proof flow. Its deployment variables (`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, optional
`VERCEL_PROJECT_ID`, `OPENSESAME_CONNECT_MANAGE_KEY` and
`OPENSESAME_CONNECT_APP_ORIGINS`) belong to that integration, and are not
prerequisites for Linear's direct-browser flow.

## Verification

See [ADR 0184](../adr/0184-browser-linear-authorization.md). Provider protocol
and browser tests cover both actor consent flows, replay refusal, workspace
and scope verification, token rotation, awaited operations, webhook recovery,
provider revocation and encrypted reload. Automated authenticated tests use
a disclosed protocol test authority. Live Linear CORS preflight checks use
its official endpoints without credentials; live account consent uses the
application and Linear account supplied by the deployment's user.
