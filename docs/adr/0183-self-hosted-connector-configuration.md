# ADR 0183 — Self-hosted connector configuration follows the Connect experience

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** OpenSesame maintainers
- **Amends:** [ADR 0147](0147-connector-plans-and-user-token-proof.md)
  (connector plans and hosted user-token proof)
- **Uses:** [ADR 0133](0133-shared-app-core.md) (shared application core),
  [ADR 0149](0149-nothing-stored-in-the-clear.md) (encrypted storage)

## Context

Opening Linear showed Vercel management credentials rather than Linear's
configuration. This confused the desired interaction pattern with the hosted
service that inspired it. The goal is a connector experience people can
self-host in a browser: pick the provider, choose how to configure an app,
review workspace and permissions, name it, and save it locally.

The catalog's managed marker describes what the upstream registry offers.
It does not establish that a self-hosted deployment owns a provider OAuth
application. A local configuration also does not establish provider consent
or a working token.

## Decision

1. Reuse the Connect configuration pattern with provider-specific content.
   Linear offers a workspace field, connector name, separate app and user
   scope selections, webhook resource selections and an optional icon.
   Generic provider endpoints and OAuth scope choices continue to come from
   `connectPlan`; no second connector list is introduced.
2. Keep optional provider fields and default selections in
   `spec/connectors/self-hosted-config.json`, read and validated by
   `app-core/lib/self-hosted-config.ts`. Unknown plans, duplicate choices and
   scope defaults absent from the provider's plan are rejected. Linear's
   initial selections match the product reference: four app scopes, two user
   scopes and two webhook resources. Its OAuth and webhook docs define the
   choice vocabulary; these initial selections are not provider recommendations.
3. **Managed** means a provider app operated by the self-hosted deployment.
   **Bring Your Own** means an app supplied by the person configuring the
   connector. Neither choice implies that a Vercel-owned app is available.
   Without deployment provisioning, the operator must supply an app. The
   browser does not silently create a provider OAuth registration.
4. Create and update commit configuration and credentials together in one
   encrypted device record. Secret values are excluded from the saved form
   draft and public connector row; legacy device records remain readable.
   Creating a local configuration requires no Vercel
   account, token, team or project and makes no hosted Connect API call.
   The form waits for storage completion before clearing credentials or
   reporting success. Write failures retain the draft for retry and report
   errors. Saves serialize under a browser lock and refresh storage before
   changing records. Durable deletion masks legacy copies so they cannot
   reappear after a reload. A
   memory-only backend reports session storage rather than durable storage.
5. A local configuration stays pending with no granted scopes. Its status
   says authorization is required. App/user scope and webhook selections
   describe intended settings; they are not provider grants, registered
   webhooks, accepted credentials or evidence of a usable token. Provider
   consent and token handling still belong to an authority that supports
   the provider's authentication protocol.
6. Preserve the Vercel relay as an optional integration. Its management
   credentials and hosted token-proof behavior are not prerequisites for
   the default self-hosted form.

## Consequences

Users see Linear configuration when they choose Linear, including on a static
deployment with no Vercel account. Operators are responsible for the provider
applications and authorization authority they deploy. Configuration can be
verified offline; live authorization and token proof require separate evidence.

The [operator guide](../operators/connect-connectors.md) describes the local
flow, its storage and the limits of its configured status.
