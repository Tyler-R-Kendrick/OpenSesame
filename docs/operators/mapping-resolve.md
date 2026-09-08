# Host-to-Identity mapping

The Host resolves an exact upstream issuer and subject using the separately
deployed Identity service. Email is never a join key.

Set `OPENSESAME_API_URL` (or `OPENSESAME_IDENTITY_URL`) to the canonical Identity
origin and provide a dedicated `OPENSESAME_MAPPING_RESOLVE_TOKEN`. The NATS
callout secret is not a fallback. The credential must authorize only mapping
resolution on Identity; it is not a browser or operator credential.

The endpoint must have no path prefix, user information, query, or fragment.
HTTPS is required for networked or production deployment, including networked
deployments labeled development. Explicit local development may use loopback
HTTP. DNS is bounded, checked using the shared public-destination policy, and
pinned for the request. Redirects and environment proxies are disabled. A
loopback HTTP endpoint must resolve exclusively to loopback addresses.

For an intentional private HTTPS deployment, set
`OPENSESAME_MAPPING_PRIVATE_ENDPOINT` to the exact canonical origin including
its trailing slash. This opts that endpoint into private-address routing; TLS
still verifies its configured host identity. It does not enable HTTP, redirects,
or a wildcard private-network allowance.

Requests have a two-second DNS/connect limit and five-second HTTP deadline.
Responses are capped at 8 KiB and decoded as a strict flat mapping record.
Issuer and subject must match the request; principal and assurance are validated.
Logs and errors contain stable local codes, never response bodies, credentials,
or credential-bearing URLs. Mapping unavailability fails authentication closed.

Rotate the dedicated token on both services together. Keep the previous
configuration securely available for an operator-controlled rollback; never
restore the former NATS-secret fallback or a redirect-following client.
