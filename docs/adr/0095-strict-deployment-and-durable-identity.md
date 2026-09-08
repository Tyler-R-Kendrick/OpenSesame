# ADR 0095: Strict deployment mode and durable Identity state

Status: accepted

## Context

A missing or misspelled production label previously selected development
behavior. Binding loopback while advertising a remote public URL could also
hide network exposure. Ephemeral Identity state loses replay, session and
revocation decisions across restart.

## Decision

Rust and TypeScript resolve the same semantic deployment model and shared
truth-table fixture: mode is exactly `development`, `test` or `production`;
exposure is local-only or networked. Both `OPENSESAME_ENV` and `NODE_ENV`
are validated when present and must agree. Empty, differently cased, unknown
and conflicting values fail. Ambient test-runner detection supplies no mode.

Missing mode is admitted only with `OPENSESAME_ALLOW_DEV_DEFAULTS=1` and local
exposure. The flag accepts exactly 0 or 1 and is refused for network exposure.
Effective listeners and configured public/resource/issuer/service URLs
participate in exposure classification. Production mode or network exposure
requires production safeguards; a development label cannot relax them.

Gateway startup resolves security configuration before durable initialization
and listener binding. Required operator, claim-pepper and signing material
must satisfy their explicit validation; missing claim pepper is an error, not
an empty-string fallback. Local scripts generate high-entropy runtime material
outside version control. There is no shared development credential to copy
from documentation.

Self-hosted Identity defaults do not silently trust the author's Pages origin
or Shoo. Explicit issuer/provider configuration is a server trust decision,
separate from Pages' compiled Google-via-Shoo sign-in choice.

Production Identity requires DATABASE_URL and refuses injected memory/store
composition seams. It constructs its durable repositories and security stores
from that database, runs migrations, and waits for initialization before
serving. Readiness performs a durable write/read/delete transaction in addition
to checking initialization; a nonempty DSN is not proof of healthy storage.
Sessions, OIDC state, claims, passkeys, mappings, replay and related domain
stores use the database-backed composition.

## Migration and rollback

Operators must explicitly set a valid mode, resolve inherited NODE_ENV
conflicts, configure exact owned endpoints and provide required secrets.
Development scripts must use local URLs consistently rather than relying on
non-loopback historical defaults. Changing a label does not make an exposed
deployment local.

Back up durable databases before migrations. Preserve signing and pepper
material across restart according to the relevant key-rotation procedure.
Rollback requires a compatible database backup and binary, with services
stopped; do not restore old fail-open configuration to regain availability.

This requirement applies to the networked Identity service, not the offline
Pages vault. Opening Pages, choosing guest and using a local vault still
requires no Host, daemon or server database.

## Evidence and limits

The shared truth table, startup refusal tests and durable store/replica tests
exercise these boundaries. Database readiness establishes current access to
the backing store, not proof of every future transaction or backup recovery.
Injected test databases are not evidence of production deployment configuration.
Final full-stack, restart and migration gate results belong in the release
evidence; this ADR does not assert they have all passed.
