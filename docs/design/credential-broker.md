# Credential broker

Competitive contract for [1Password Credential Broker](https://www.1password.dev/brokered-access)
and its OIDC workflow path. The target is capability and API parity for
workloads, not a clone of 1Password Environments or its provider list.

Status: target design. This checkout has environments, OIDC/agent-auth
primitives and machine-identity research, but no credential-broker integration
record, workload OIDC exchange, environment-variable broker or load-secrets
action.

## 1Password behavior

An administrator creates an **integration**:

- GitHub Actions preset: GitHub organization on `github.com`; integration key.
- Custom OIDC: issuer URL, discovered or manual JWKS URL, required claims,
  expected audience; integration key.

A team member connects a **1Password Environment** to a workflow:

- choose the integration;
- add workflow conditions (GitHub repository, branch, environment, workflow);
- the Environment ID, workload ID and integration key form the runtime inputs.

At runtime:

1. Workflow obtains a short-lived OIDC token from its provider.
2. SDK/action calls 1Password with the OIDC token, workload ID and integration
   key.
3. 1Password verifies issuer, signature, audience and every configured claim.
4. Only then does it return the Environment's variables.
5. Access lasts for the workflow and every access is audited.
6. Deleting the integration stops associated workflows.

1Password ships a JavaScript SDK and a GitHub Action; the integration key is a
customer-managed secret used to decrypt secrets in the workflow.

## Current OpenSesame pieces

| Piece | State |
|---|---|
| Environment item type and `env.schema` | Yes |
| Human OIDC/SAML login | Yes |
| Provider ID-JAG / AgentAuth | Partial, experimental trust path |
| SPIFFE X.509 / mTLS workload identity | Yes, transport |
| Machine identity OIDC auth | Target only |
| Integration record | Missing |
| OIDC workload exchange | Missing |
| Environment variable broker API | Missing |
| JS SDK / GitHub Action | Missing |
| Broker audit and receipt | Missing |

## Target model

```text
BrokerIntegration
  id, organizationId, name
  kind: github_actions | oidc
  issuer, discoveryUrl, jwksUrl
  audiences[]
  requiredClaims: { claim: valueOrGlob }[]
  environmentIds[]              # what this integration may broker
  key: { wrappedKey, kdf, createdAt, rotatedAt } | null
  state: active | disabled
  createdBy, createdAt, updatedAt

WorkflowBinding
  id, integrationId, environmentId, name
  conditions: { claim: valueOrGlob }[]
  state: active | disabled
  createdBy, createdAt

BrokerSession
  id, integrationId, bindingId, environmentId
  workloadId
  oidcClaimsDigest
  issuedAt, expiresAt            # max 15 minutes
  proofKeyThumbprint             # DPoP or one-time handle
  revokedAt
```

Rules:

- One integration names one issuer and one JWKS/discovery source.
- Every configured allowed claim must match; missing, extra, or array-valued
  claims are handled explicitly, never by substring guessing.
- Audience is a hard match. `aud` may be a string or array; the token must
  contain one configured audience.
- The OIDC token must be unexpired, not-before valid, and within a small clock
  skew. Issuer must equal the configured issuer.
- JWKS is cached with a bounded refresh window; a stale key never falls back to
  unsigned acceptance.
- A binding narrows an integration; it cannot widen it. The final policy is
  integration ∩ binding ∩ environment scope.
- A session is proof-bound. A copied session handle alone is not enough.
- Broker sessions are at most 15 minutes and cannot be refreshed; a new OIDC
  exchange creates a new audited session.
- Environment variables are returned only to the bound workload, never logged,
  never placed in a URL, and never returned after expiry or integration disable.
- The integration key is optional. When present it is a customer-managed
  wrapping secret; when absent, the Host's organization key performs the same
  envelope operation. This is safer than making every workflow carry a
  long-lived decrypting secret, while accepting the 1Password shape for parity.
- Deleting an integration disables every binding and session immediately.

## Runtime API

Two equivalent shapes:

### Compatibility exchange

```http
POST /v1/credential-broker/exchange
Content-Type: application/json

{
  "integrationName": "GitHub Actions",
  "integrationVersion": "v1.0.0",
  "workloadId": "wl_...",
  "oidcToken": "<workflow OIDC JWT>",
  "integrationKey": "<optional customer-managed secret>"
}
```

`200` returns variables for the environment bound to that workload:

```json
{
  "environmentId": "env_...",
  "variables": [{ "name": "DOCKERHUB_USERNAME", "value": "..." }],
  "expiresAt": "2026-10-21T12:15:00Z",
  "receiptId": "rcpt_..."
}
```

### Session shape

```http
POST /v1/credential-broker/sessions
-> { sessionId, expiresAt, proof, environmentId }

GET /v1/credential-broker/environments/:id/variables
Authorization: DPoP <proof>
-> { variables, expiresAt, receiptId }
```

The session shape is the preferred SDK path. The exchange shape exists for
1Password-style compatibility.

Errors are typed and safe:

| Code | Meaning |
|---|---|
| `oidc_invalid` | Signature, issuer, audience, claim or time failed |
| `workload_unknown` | Workload id is not bound |
| `integration_disabled` | Integration or binding is disabled |
| `environment_not_bound` | Environment is outside the integration scope |
| `key_invalid` | Customer-managed key failed to unwrap |
| `session_expired` | Broker session is past its deadline |
| `proof_invalid` | Session handle was replayed or not proof-bound |

No error distinguishes "wrong issuer" from "unknown workload" beyond what the
caller already knows.

## GitHub Actions preset

The GitHub integration fixes `issuer` to `https://token.actions.githubusercontent.com`
and checks the immutable subject format, including numeric owner/repository IDs
where GitHub supplies them.

Conditions:

- repository (`repo:owner/repo` or immutable form);
- branch/ref;
- environment;
- workflow ref;
- event name;
- audience (default the OpenSesame broker audience).

The workflow must set `id-token: write`. The action requests a token for the
broker audience, exchanges it, and exports variables only for that step/job.

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: opensesame/load-secrets-action@v1
    with:
      export-env: true
    env:
      OPENSESAME_WORKLOAD_ID: ${{ vars.OPENSESAME_WORKLOAD_ID }}
      OPENSESAME_ENVIRONMENT_ID: ${{ vars.OPENSESAME_ENVIRONMENT_ID }}
      OPENSESAME_INTEGRATION_KEY: ${{ secrets.OPENSESAME_INTEGRATION_KEY }}
```

## SDK

The JavaScript SDK mirrors the useful 1Password shape without requiring a
customer-managed secret:

```ts
const client = await broker.createClient({
  integrationName: "GitHub Actions",
  integrationVersion: "v1.0.0",
  oidcFetcher: () => process.env.GITHUB_ID_TOKEN,
  workloadDetails: {
    workloadId: process.env.OPENSESAME_WORKLOAD_ID,
    customerManagedSecret: process.env.OPENSESAME_INTEGRATION_KEY,
  },
});

const { variables } = await client.environments.getVariables(
  process.env.OPENSESAME_ENVIRONMENT_ID,
);
```

Go and Python SDKs should follow; the wire API is the contract, not JS.

## Native and PWA

- **Host/Identity**: owns integrations, bindings, OIDC verification, sessions,
  audit and the environment-variable endpoint.
- **Native**: `opensesame broker` can serve a local/private instance and the
  GitHub Action/SDK calls it. It can also act as the OIDC client for a workflow.
- **PWA**: administration only: create integrations, verify issuer/JWKS,
  define claims, connect environments, inspect sessions/receipts and revoke.
  It never hosts the broker endpoint and never holds a workflow's integration
  key after submission.
- **Environment storage**: the existing environment item remains the source of
  variable names and bindings; secret values are resolved at the Host, never
  copied into the PWA session log.

## Outperformance

- Proof-bound broker sessions, not a bearer response that can be replayed.
- No mandatory long-lived integration key; customer-managed wrapping is
  optional rather than the only mode.
- Exact issuer/JWKS/audience/claim matching with replay resistance.
- Binding is intersection-only; a workflow condition cannot widen an
  integration.
- One environment per exchange; no accidental access to another environment.
- Every exchange and variable read produces a receipt with a digest, never the
  values.
- Revoke/disable is immediate, not a cache or poll interval.
- Existing environment items and schema validation are reused; no second
  secrets store.

## Delivery slices

1. **Integration and binding records.** Sealed storage, owner/admin API, PWA
   management list.
2. **OIDC verifier.** Discovery/JWKS cache, issuer/audience/claims, GitHub
   preset, bounded clock skew, replay protection.
3. **Exchange and session API.** Workload binding, proof-bound session,
   environment resolution, typed errors, receipt.
4. **JavaScript SDK + GitHub Action.** OIDC fetcher and export-env path.
5. **Native `opensesame broker`.** Private/self-hosted endpoint and CLI.
6. **Audit and lifecycle.** Integration/binding revoke, session expiry, key
   rotation, redacted activity, notifications.
7. **Go/Python SDKs and compatibility tests.** Exchange shape and session shape.

## Acceptance

- A valid GitHub OIDC token plus the bound workload returns only that
  environment's variables.
- A token from the wrong issuer, wrong audience, expired token, missing claim,
  wrong repository, branch, environment or workflow is refused before any
  variable is read.
- A copied session handle without its proof is refused.
- An integration or binding delete/disable stops the next exchange immediately.
- The integration key, OIDC token, variables and receipt never appear in logs,
  URLs, model context or PWA globals.
- A workflow can use the action to export variables to the environment and to
  step outputs.
- SDK exchange and session shapes return the same variables and audit outcome.
- Deleting an integration does not delete the environment item.
