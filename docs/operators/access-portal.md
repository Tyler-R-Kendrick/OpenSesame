# Access portal

Access is the local PAM plane. Its six tabs (Grants, Requests, Sessions,
Connectors, Resources, Policies) read sealed local records, so it needs neither
the Identity service nor a Host, and neither is required to open the offline
vault. No Host panel is drawn on Access: pairing a browser with a Host is a
native ceremony described in
[Migrating local authority](local-authority-migration.md).

## What an Identity service adds

Set the Identity API address on the Identity screen (**Connect a sign-in
service**) or on the setup Identity tab. With an address set, **Requests** also
draws **Requests for you**: the authorization requests addressed to your
Identity session, beside the local ones. When no Identity session is held the
panel shows **Connect**; **Reload requests for you** reads again. A row decides
nothing: it opens the full review at `/approve/<ref>`, where the decision is
bound to the request's digest, verb and policy. No operator credential belongs
in the browser. A self-hosted service must be running; a static page cannot
become an OIDC or approval server by itself.

**Sessions** draws **Receipts** when the Identity plane serves an audit trail:
the device's own once Browser-local IAM is on, or the service's once you are
signed in to it ([browser-local IAM](browser-local-iam.md)).

## Operate

| Tab | Panels and operations | Authority |
| --- | --- | --- |
| Grants | **Portable grants** (the access book, drawn once it holds a grant; import and export keys sit in Access's title row, and export saves `access.json`), **Local application grants** (revoke, with a confirmation), **Identity shares** (grant a share: identity, resource, policy, duration; revoke) | Sealed local records |
| Requests | **Requests for you** (with an Identity API), **Local requests**: create one for an application (requesting identity, application, redirect URI, scopes, reason), approve or deny it with a passkey as an authorized person | Local identity session and passkey; Identity digest-bound consent for hosted rows |
| Sessions | **Local sessions** (revoke), **Audience templates** (a read-only list of declarative templates and their support matrix), **Vault share sessions** (start, stop or restart a time-boxed share with a join code), **Receipts** | Sealed local records; Identity-plane audit trail |
| Connectors | Who may use which connector: **Add** chooses a connector configured or imported on Connections and who may use it; **Revoke** ends a grant early | Local share grants of kind `connection` (ADR 0115) |
| Resources | **Local resources**: what a grant can point at, and who holds a standing share of each | Local admission policy |
| Policies | **Local application policies**: one block per local application, with its registration and the roles allowed per permission | Local admission policy |

A local request records consent, not a new resource grant: creating one says
"No access was granted", and approval is a separate decision by an authorized
person, with a passkey. Hosted requests are reviewed at `/approve/<ref>` on the
Pages deployment. That route needs an Identity session, not an unlocked vault,
and shows the exact request; depending on its policy the review asks for a
passkey touch for that exact request and a comparison code from where the
request started.

Audience templates are local UI only: selecting one is not a grant ledger and
not remote enforcement. Access does not provide an SSH or database terminal.

## Failures

An expired request cannot be approved. Reload the inbox and ask for a fresh one.
Cancelling an authenticator does not decide the request. Closing a review
cannot roll back a decision already accepted by the service.
