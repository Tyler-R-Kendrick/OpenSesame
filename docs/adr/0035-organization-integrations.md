# ADR 0035: Provider templates, organization integrations, and member connections

## Status
Accepted

## Context
ADR 0032 introduced the authority-plane broker and immutable provider catalog. A single
deployment-wide OAuth application is useful locally, but organizations need multiple named
OAuth applications for the same provider without letting API callers redefine endpoints or
egress policy.

## Decision
1. Built-in provider templates remain the only source of authorization/token endpoints,
   scope vocabulary, operations, and egress bindings. Arbitrary providers and endpoint
   overrides are not an organization API.
2. An organization integration selects one template and stores a unique key, display name,
   scope ceiling, enabled state, OAuth client id, and encrypted client secret. Responses
   expose only a client-id hint and whether a secret exists.
3. Owners and admins create, update, disable, and delete integrations. Members may list and
   use enabled integrations, and continue to own only their connections.
4. Environment-configured applications are stable read-only integrations. Their source is
   `shared_dev` outside production and `deployment` in production. The mock provider is
   never exposed in production.
5. Every new connection is pinned to `integration_id`. Legacy provider-only creation works
   only when one usable integration is unambiguous, and the chosen id is persisted before
   OAuth state is issued.
6. Integration scope ceilings are checked at connection creation and authorization. Disabling
   blocks new authorization and credentials; revocation remains available. Deletion is
   atomically refused while any connection references the integration.
7. Revocation is terminal. The broker records revoked state and removes credentials and
   pending authorization state before optional upstream network work; late writers use a
   compare-and-set and cannot reactivate it.

## Consequences
- Integration metadata is organization-scoped and safe to render in clients.
- OAuth callback URLs are derived from broker configuration and exposed on provider and
  integration reads for administrator setup.
- Multiple named instances of one provider are supported without widening catalog egress.
