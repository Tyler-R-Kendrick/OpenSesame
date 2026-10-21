# Bring-your-own connections

A curated catalog cannot cover every internal API, tenant, or legacy identity
provider. Connections therefore has a header **+** beside Reload: it opens one
form that creates a connection and the vault item that holds its credential.

## Creation

The form chooses one method first:

| Method | What the form asks for | What the vault item holds |
|---|---|---|
| OAuth | Base, authorization and token URLs, client id, optional client secret, scopes | The client secret (when there is one), with the public endpoints on the item |
| Basic auth | Base URL, username, password | The password |
| API key | Base URL, header name, key | The key |
| SAML | Entity id, metadata URL or XML, optional private key | The private key, with public metadata on the item |

The item type is `byo-connection`, installed into the vault on first use. It
stores the credential in its one concealed native secret (`credential`) and
keeps public metadata in the trailer. The connection record keeps only the
item id, method, service and base URL; it never carries a secret.

The vault item is the fallback surface: sharing or granting it follows the
vault's own policies. Removing the connection does not remove the item.

## Brokered use

A connection is meant to be consumed through the Host's session endpoints, not
by handing a client the item's credential. A client presents its session; the
endpoint mints a self-issued derivative credential bound to that session and
connection, and the proxy resolves it to the original sealed credential at the
last hop. The original never crosses the client boundary.

The browser-owned record contains no secret, so it is safe to list, log and
sync. The session mint and proxy are Host-plane work; this page's local record
is deliberately useful without them (the vault item remains the source of
truth) and must not grow a second copy of the credential to fake them.

## Boundaries

- The form refuses an HTTP base URL for OAuth, Basic and API key methods.
- SAML metadata is accepted as HTTPS XML or inline XML, but the private key is
  optional: some profiles use a protected assertion consumer instead.
- The item type is ordinary manifest data, so another device receives it with
  the item through the sealed `itemTypes` record.
- The connection page links to the item; it never reveals the credential.
