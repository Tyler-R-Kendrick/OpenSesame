# ADR 0217 — The AWS mint: STS AssumeRole for a bound role

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR 0049](0049-derived-short-lived-materialization.md) §3 (the aws
  provider mapping, left a `422 unmintable` follow-up)
- **Builds on:** [ADR 0005](0005-authority-handle-connectionref.md),
  [ADR 0048](0048-capability-moded-connector-discovery.md) D6/D7 (invoke-through),
  [ADR 0074](0074-expiry-lifecycle-hooks.md), [ADR 0157](0157-logs-and-events-carry-no-secrets.md)

## Context

ADR 0049 §3 mapped aws onto STS and stopped there: the gateway answered every
aws-family mint with `422 unmintable`, and `opensesame-credential-process`
failed closed. A deployer that needs AWS credentials at deploy time had two
roads, both worse than a mint: an IAM key pair in `~/.aws/credentials`, or no
AWS at all. The key pair OpenSesame already holds as a sealed connection is the
credential STS was built to derive from.

## Decision

1. **The source credential is an ordinary sealed connection.** An `aws`,
   `aws-kms`, `aws-ps` or `aws-bedrock` connection whose configuration holds
   `access_key_id` and `secret_access_key` (and optionally `session_token`) is
   the source. It is opened for one signature and dropped; no route, log line,
   event or receipt carries it. `aws-sts` holds no key on the Host and cannot
   be bound.
2. **The operator binds a role; the caller cannot.** `PUT
   /api/v1/connections/{id}/aws-sts-binding` (owner or operator, administrator
   role, like the mint) takes `role_arn`, `region`, `max_duration_seconds`
   (900–3600, default 900), an optional `session_policy` (an IAM policy
   document, minified, at most 2048 characters) and an optional `external_id`.
   The whole binding is sealed under the connection key with its own associated
   data (`aws_sts_binding`). `GET` answers a value-blind view (the role, the
   region, the cap, and whether a policy and an `ExternalId` are set); the
   `ExternalId` never comes back out. `DELETE` removes it. No binding means no
   mint path: the connection stays `422 unmintable`.
3. **`AssumeRole`, shaped by the Host.** `DurationSeconds` defaults to 900 and
   may be asked for up to the binding's cap; a request outside `900..=cap` is
   refused (400), never clamped. `RoleSessionName` is `opensesame-<grant id>`
   (a fresh UUIDv7 per mint, checked against STS's `[\w+=,.@-]{2,64}`), so
   CloudTrail and the Host's receipt name the same mint. `SourceIdentity` is
   the calling principal, escaped into STS's charset (`=XX` for every other
   byte, `=` included, hashed past 64 characters). It is never the recorded
   actor: a mint the daemon forwards for a local process (ADR 0138 §2) is
   recorded as `<principal> on_behalf_of=uid:…,pid:…`, and that note stays in
   the receipt and event, out of STS. `Policy` and `ExternalId`
   come from the binding only. STS intersects a session policy with the role's
   own permissions, so it can only narrow. The role's trust policy must allow
   `sts:AssumeRole` and `sts:SetSourceIdentity` for the source principal.
4. **Signing is `aws-sigv4`'s.** `aws-sigv4 =1.3.8` (default features off,
   `sign-http` only; with `aws-credential-types =1.2.11` and
   `aws-smithy-runtime-api =1.11.3` to name its key and identity types) signs
   the request. It is the signer every AWS Rust SDK uses, and it alone is
   enough: `aws-sdk-sts` would add the SDK's runtime, retry and HTTP stacks
   for one form POST the broker already knows how to send. The crate traces the
   canonical request — `x-amz-security-token` included — at `trace` level, so
   every signature is computed under a `NoSubscriber`; no log filter brings
   those lines back. These crates live in the connection broker, which the
   daemon never links (ADR 0048 D5): the daemon's dependency budget is unchanged.
5. **The call goes through invoke-through.** A new `AuthStyle::SigV4` rule is
   reachable only through `Invoker::execute_signed`, which shows a
   `RequestSigner` exactly the method, URI, headers and body it then sends,
   and a bearer rule is never signed (nor a SigV4 rule given a bearer). Each
   mint's rule names one host, the binding region's `sts.<region>.amazonaws.com`
   from a compile-time table; it is the broker's own and never joins the
   daemon's `EGRESS_RULES`. No redirect is followed, the body is capped at
   16 KiB, the call times out after 10 s, and the response is scrubbed of the
   source secret and session token.
6. **The answer is read boundedly and trusted narrowly.** `quick-xml =0.41.0`
   (already in the lock through the KDBX bridge) reads the body event by event:
   no DTD, depth ≤ 8, ≤ 512 events, values ≤ 4096 bytes, no entity inside a
   captured value, no field twice, each in STS's documented shape. An
   `Expiration` in the past or later than now plus the requested duration plus
   300 s of skew is refused.
7. **Every failure is a stable code with no upstream words.**
   `aws.sts.access_denied` (502; `AccessDenied` and any other client error),
   `aws.sts.expired_source` (502; `ExpiredToken`, `InvalidClientTokenId`,
   `SignatureDoesNotMatch`), `aws.sts.region_disabled` (502),
   `aws.sts.throttled` (429), `aws.sts.malformed_response` (502; unparseable,
   oversized, a redirect, an untrusted expiration), `aws.sts.unreachable`
   (504; timeout, transport, 5xx). There is no retry: an `AccessDenied` is
   final, and the caller retries a throttled or unreachable STS itself.
8. **The response.** `POST /api/v1/connections/{id}/mint` (optional
   `duration_seconds`) answers the common mint fields with `kind:
   aws_sts_assume_role`, `derived_token` the session token, the STS triple at
   the top level (`access_key_id`, `secret_access_key`, `session_token`) where
   `opensesame-credential-process` reads it, and a `receipt`. The daemon's
   `/v1/mint` forwards `duration_seconds` and passes the answer through
   untouched; the helper reads `OPENSESAME_AWS_DURATION_SECONDS`.
9. **Receipts and the lifecycle feed.** Every mint writes a value-blind receipt —
   grant id, role ARN, session name, source identity, duration, expiry, STS's
   request id — as the connection's `materialized` event (sealed at rest by the
   event path, ADR 0157), and a refused mint an `error` event carrying only its
   code. The deadline goes to a plain-column register (`aws_sts_mints`) that
   the lifecycle scanner reads, so each minted credential is a
   `connection_credential` subject (`aws-sts-mint:<grant id>`) whose expiry
   publishes on the `lifecycle.*` feed. Like a session or authority grant it
   is on the alert ladder, so subscribers hear `lifecycle.expiry.expired` when
   it lapses; a credential that lives under a day reaches `urgent` on its first
   pass. It never auto-responds: nothing renews a minted credential; the agent
   that needs another mints again. A lapsed mint stays in the register for a
   day after its deadline, so each pass reads the register twice, each read
   bounded at 512 per organization: live mints soonest first, and lapsed ones
   most recently lapsed first. Mints whose expiry was already published never
   crowd a live or newly lapsed one out of a pass; one is missed only when
   more than 512 in its organization lapse after it before the next pass.

## Consequences

- An agent's AWS CLI or SDK gets a credential that lasts 15 minutes to an hour,
  scoped to one role and, optionally, a narrower session policy, and never sees
  the key it was derived from.
- The binding route is a new Host API capability
  (`connections.aws_sts_binding`); it is administrator configuration and is
  excluded from every agent surface under this ADR and ADR 0065.
- Not verified here: a real AWS account. The STS behaviour is held to by a
  loopback stand-in that verifies SigV4 with the same crate and answers the
  documented XML; a deployment should mint once against a role it controls
  before handing the profile to an agent.
- The aws helper reaches a real daemon because the daemon's `/v1/mint`
  authenticates a Unix-socket caller by its kernel-attested peer credentials
  and mints, with no operator token, a connection the operator allowed
  (`opensesame daemon helpers allow`; ADR 0138 §2 as amended). That change is
  its own pull request, and this one builds on it.
- The Host reads `OPENSESAME_TEST_AWS_STS_ENDPOINT` only in a build with the
  broker's `sts-stand-in` feature, which the CLI's tests enable and a shipped
  build never does; the endpoint then admits loopback hosts alone.
