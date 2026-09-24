# auth.md

You are an agent. This **static** origin has no application backend and no client secret.

Authorization server: set at deploy time (default `http://127.0.0.1:8788`).
Protected resource metadata: `/.well-known/oauth-protected-resource`.

Register at the authorization server:

```http
POST /agent/identity
Content-Type: application/json

{ "type": "anonymous" }
```

Then exchange the returned `identity_assertion` at `/oauth2/token` with
`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`.

Runtime metadata on the Identity API is authoritative.
