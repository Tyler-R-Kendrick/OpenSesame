# ADR 0111: Browser-local access requests

Status: accepted

Local IAM needs durable request creation and human decisions without a Host or
Identity endpoint. Requests use the existing domain Interaction lifecycle and
the vault's encrypted VFS, sharing the directory/session Web Lock.

Creation requires a genuine local person or agent session and current application
admission. A bounded record freezes requester/session, organization, application
and policy revision, callback, scopes, reason and five-minute expiry in a digest.
A reference grants nothing. The custodian can read metadata or withdraw pending
authority; history deletion is limited to terminal records.

Approval or denial requires an enabled human owner/admin with application scope
admission. Fresh WebAuthn commits to request digest, decision and approver.
After verification the commit rechecks record version, policy, membership and
credential under the same lock. No session projection or user-supplied assurance
is accepted as proof. Concurrent decisions have a single winner.

Consumption requires the original private requester session and unchanged
policy, membership and approving key. It persists the canonical consumed state
before invoking an effect under the fence. Failure after that write burns the
approval; the requester must create a new request rather than replay an uncertain
effect. The effect must not reacquire the directory lock.

Requests are separate from existing browser application grants. An approved
request alone is neither a remotely usable token nor an application session.
The requesting operation must consume it; the UI must not pretend that recording
approval executed an application operation. Host/Identity workflows remain
optional, separate surfaces. Agents may initiate authenticated requests through
their client boundary but cannot invoke the custodian UI's approval or directory
administration as an MCP tool.
