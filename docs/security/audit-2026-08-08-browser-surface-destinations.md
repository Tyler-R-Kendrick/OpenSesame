# Audit 2026-08-08 — where the browser apps send secrets, and what their outbox holds

Tick 71 read the two browser surfaces that nothing had audited yet: the offline
Pages app and the console. Both hand a machine-local secret to a URL that somebody
else chose, and the Pages outbox treats durable storage as trustworthy input.

## The operator token followed a configurable URL off the machine

`apps/pages` persists `hostApi` and `identityApi` as plain strings with no
validation, and `TaskPage` attaches `Bearer operator:<token>` to whatever `hostApi`
names. The operator token is a secret shared between processes on one machine — the
same secret the daemon was stopped from forwarding in tick 61 and that `mcp-host`
already confines to loopback. Here there was no such fence: any `hostApi` (including
`http://` to a remote host, or one with embedded credentials) received it.

The console has the same shape from the other direction: `VITE_OPENSESAME_OPERATOR_TOKEN`
is a build-time variable, so the token can end up inside the shipped bundle and was
sent to whatever gateway that build pointed at.

Both now go through `operatorHeadersFor(base, token)`, which offers the bearer only
when the base names this machine. `apps/pages` additionally refuses a base it would
not accept — https, or http on loopback, never with embedded credentials — both when
saving settings (the form now says why) and when reading them back, because storage
is not a place where a destination earns trust by having been written once.

## The offline outbox was an unvalidated to-do list of privileged calls

`loadQueue` parsed OPFS JSON and cast it to `QueuedAction[]`. A flush turns each
entry into a device approval or a claim completion, so anything able to write our
storage could stage a device approval the person never saw and have the app perform
it on the next flush. Entries also never expired, were never capped, and one that
could not succeed threw out of the flush loop and blocked everything behind it —
leaving claim tokens sitting in durable storage indefinitely.

The queue is now read as untrusted input: shape-checked per kind, claim tokens
required to look like claim tokens, entries older than a day dropped (their tokens
are dead by then anyway), the list bounded to 32, and a failing item counting its
attempts until it drops itself instead of holding the outbox hostage.

## The screen showed the secret half of a claim token

The queue rendered `claim token …${claimToken.slice(-8)}` — and the token is
`osc_clm_<id>.<secret>`, so those last eight characters come from the secret half.
It now shows the id half, and the panel's copy no longer claims the queue holds
"no secrets", because a queued claim carries its token.

## Not fixed here

- The Pages outbox flush still sends `credentials: "include"` to the Identity API.
  The destination is now validated, but cookie-bearing cross-origin ceremony calls
  from a static page deserve a CSRF story of their own.
- The console's operator token is still readable in a build that sets the variable.
  Keeping it out of production builds remains a deployment convention, not a fence.
