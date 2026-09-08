# Migrating local authority and deployment configuration

This procedure describes the integrated hardening interfaces. It is not a
production-readiness declaration or a record of completed release verification.
Keep offline Pages use independent of these optional services.

## Resolve deployment configuration first

Set `OPENSESAME_ENV` to exactly `development`, `test` or `production`. If
`NODE_ENV` is inherited, it must be a valid value and agree. `prod`, whitespace
and differently cased labels are refused. Missing mode requires explicit
`OPENSESAME_ALLOW_DEV_DEFAULTS=1` and entirely local exposure; this flag is not
permitted with network exposure. The accepted flag values are 0 and 1, not
the historical `true` spelling.

Review every listener, public URL, resource, issuer and Host/Identity/callback
endpoint. A loopback listener does not cancel a networked public URL. Explicit
development mode with network exposure still requires production safeguards.
Use the checked-in local development launcher to generate runtime secrets;
never put universal example credentials or generated secrets in version control.

Gateway requires an explicit high-entropy operator token and claim pepper.
Production/networked operation also requires persistent receipt signing
material. Identity requires its configured service/signing secrets and durable
DATABASE_URL; production refuses injected memory repositories. Back up databases
before migration and preserve signing/pepper material across restart. Wait for
readiness after migrations rather than checking only that a socket is open.

## Pair an eligible browser

Choose either a loopback Pages origin or an exclusive HTTPS deployment with
real security response headers. Build using `PAGES_DEPLOYMENT_PROFILE`,
`PAGES_CANONICAL_ORIGIN` and, for dedicated hosting, `PAGES_HEADER_SECURITY=1`.
The last flag attests a hosting configuration; setting it does not install HTTP
headers. See [Pages origin configuration](pages-origin.md).

The existing path-hosted GitHub Pages application remains a restricted
shared-origin demo. Its offline vault, Google-via-Shoo sign-in and guest roads
remain available, but endpoint settings cannot unlock local pairing.

Add only the exact eligible origin to the Host's
`OPENSESAME_BROWSER_PAIRABLE_ORIGINS`. Do not include a URL path, wildcard,
`null` or the author's shared GitHub origin. Restart with validated config.
In the Pages Host panel explicitly start pairing and read the displayed user
code. With the operator credential already supplied privately to the native
process, run:

```text
opensesame --server <exact-host-origin> local-authority pair \
  --user-code <displayed-code> \
  --principal-id <canonical-principal-id> \
  --organization-id <canonical-organization-id>
```

Inspect the native summary: exact browser origin, Host audience, proof-key
thumbprint, principal, organization and ciphertext-sync capabilities. Type
`approve` only when these match the intended request. Use `--deny` to record
a refusal. Never paste the operator token into Pages or put it in a URL.

Initial pairing permits only encrypted sync, not integration administration or
browser control. For Identity authentication, configure Host
`OPENSESAME_HOST_AUTHORIZATION_ISSUER` and its pinned public
`OPENSESAME_HOST_AUTHORIZATION_JWKS_JSON`, and Identity's explicit
`OPENSESAME_HOST_AUTHORIZATION_AUDIENCES`. Follow the separate passkey ceremony
for each purpose-bound control request. An ordinary session or recent pairing
click is insufficient. Identity role evidence cannot expand Host role ceilings.

Browser grants last at most five minutes. Lock/sign-out clears the active Pages
grant. Revoke a paired client to invalidate its grants and pending elevations;
do not assume removing a UI endpoint setting alone revokes server state.

## Launch an MCP process with narrow authority

Remove operator and generic session credentials from MCP configuration and
environment forwarding. On Unix configure the daemon's
`OPENSESAME_AGENT_SOCK` and use its absolute socket path. Choose a specific
executable and only required capabilities:

```text
opensesame --server <exact-host-origin> local-authority launch \
  --principal-id <canonical-principal-id> \
  --organization-id <canonical-organization-id> \
  --audience mcp-client \
  --capability host.sync.read \
  --socket <absolute-daemon-socket> \
  --executable <absolute-mcp-executable> -- <executable-arguments>
```

The terminal confirmation is mandatory. The launcher clears the child's
inherited environment and passes a one-use handle, client ID and endpoint
configuration, not operator authority. MCP-host and MCP-client audiences are
distinct. Available scopes are task read/create/invoke/terminate and encrypted
sync read/write; select the minimum. Expiry requires a new approved launch.

Unix exchange additionally checks daemon peer credentials. Windows uses the
explicit short-lived bootstrap-handle exchange; it does not claim named-pipe
security. A same-user attacker can still steal a live narrow bearer or race a
launch handle. See [ADR 0099](../adr/0099-scoped-local-agent-authority.md).

## Recover without relaxing controls

Recreate expired pairing or launch requests rather than restoring old tokens.
Fix invalid configuration rather than relabeling an exposed deployment. Seed
Host project roles through the explicit native policy procedure in
[config authorization](config-authorization.md), not from cached Identity roles.
Retain original encrypted data and database backups during migration. Downgrading
to a binary that lacks these checks is not a safe live rollback.

Static-auth artifact version 1.0.2 in the integration tree is a release candidate;
its presence does not establish that it has been published or independently
verified. Use the actual release manifest and immutable bytes when distributing
an SDK, and record final gate results separately.
