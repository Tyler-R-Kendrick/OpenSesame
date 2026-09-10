# Access portal

Access uses the configured OpenSesame Identity service and Host. It does not
require either service to open the offline vault.

## Connect without leaving Access

Choose **Connect Host**, enter its address, pair the browser through the native
approval ceremony, then verify Identity for Host access. Native membership and
the verified Identity handoff determine authority. Pairing alone permits only
its existing local-read scope. Public/shared-origin demo deployments cannot pair
with local authority; use an explicitly configured loopback or dedicated origin.

On **Requests**, enter your Identity API address if needed and connect. No
operator credential belongs in the browser. A self-hosted service must be
running; a static page cannot become an OIDC or approval server by itself.

## Operate

| View | Operations | Authority |
| --- | --- | --- |
| Grants | Mint an offer, review and claim it, narrow or revoke a grant | Host ownership and delegation policy |
| Requests | Create an addressed request, review/approve/deny, show a requester comparison code; review Host relay asks and retract offers | Identity digest-bound consent or Host holder-bound relay decision |
| Sessions | Start an explicitly scoped task, inspect its ceiling, terminate with its current version; review receipts | Host principal and organization, plus separate Identity receipts |
| Policies | Select a connection, edit its policy and manage bindings | Existing connection ownership and authorization |
| Resources | Existing resource/client management | Its own Host, Identity or local admission policy |

Share **My inbox address** deliberately with a requester. A new request needs
that address, an action, a resource, a reason and a deadline. Approval shows the
exact details and digest; passkey and comparison requirements cannot be skipped.
Passkey decisions open an Identity-origin window. Sign in to that service as the
approver and enroll an Identity passkey first; a vault-unlock passkey for another
origin is not interchangeable. Confirm the displayed request and decision there.
Access reads the recorded result from Identity; the window never returns a token.
The requester explicitly issues a comparison code and shares it with the
approver. It is returned once; losing it requires a new request. Keep the sent
request open to track it: this UI retains only the latest sent request in memory.

Approval records consent, not a new resource grant. A Host task ceiling similarly
limits a task but does not supply the grant needed to execute against a resource.
The existing task engine is in-memory and this portal does not provide an SSH or
database terminal.

Claim offers are transferable to someone holding both the token and code, subject
to the Host's admission checks. Naming connection bindings in the existing grant
flow is not cryptographic recipient binding. Share claim material only with its
intended recipient and retract unused offers.

## Failures

An expired request cannot be approved. Reload the inbox and ask for a fresh one.
A policy change during activation requires another review. Cancelling an
authenticator does not decide the request. Closing a review prevents pending
client-side work from proceeding, but cannot roll back a decision already
accepted by the service.

Host refusals after pairing usually require verified Identity and current native
membership; reconnecting is not permission to bypass either check. Revoking the
paired client invalidates its active grants. Changing the local deployment
profile at runtime cannot upgrade the shipped demo's trust.
