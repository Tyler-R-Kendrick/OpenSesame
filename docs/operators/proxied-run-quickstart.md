# Proxied run quickstart

Run a command with `osr_…` in place of a provider token. The token stays in
your sealed store. The `surrogate-proxy` plugin reads it for the run, puts it
on the request at the provider's own host, and nowhere else
([ADR 0150](../adr/0150-surrogate-credentials-at-the-last-hop.md)). This page
is the steps in order, for Vercel, with the output you should see. Installing
and pinning plugins in general is [plugins.md](plugins.md).

You need:

- `opensesame`, and `node` on `PATH`: the schema is read by
  `@env-spec/parser` through [`packages/env-spec-bridge`](../../packages/env-spec-bridge).
- The plugin binary `opensesame-surrogate-proxy` and its sha256.
- A Vercel token. Use a dummy one while you try this out.

## 1. Install the plugin and switch it on

```bash
opensesame plugins install surrogate-proxy \
  --from ./opensesame-surrogate-proxy --sha256 <64 hex characters> --version 0.1.0
opensesame plugins enable surrogate-proxy
opensesame plugins status surrogate-proxy      # "active": true, "pin": "ok"
```

A file that does not hash to `--sha256` installs nothing. Every `dev run`
checks the pin again.

## 2. Seal the token

```bash
opensesame pass init                              # once; asks for a passphrase
opensesame pass insert connections/acme/vercel    # passphrase, then the token (not echoed)
```

The entry's name comes from the connection, not from the schema:
`conn://acme/vercel` is `connections/acme/vercel`, `conn://acme/web/vercel` is
`connections/acme/web/vercel`, and `@v2` on the end is ignored. Only entries
under `connections/` are read for a run. The provider is the connection's last
segment, so it must be named `vercel`.

From a script, give the token on stdin and the passphrase in the environment.
Stdin that is not a terminal is read as one line. The token is never an
argument:

```bash
printf '%s\n' "$TOKEN" | OPENSESAME_STORE_PASSWORD=… opensesame pass insert connections/acme/vercel
```

`pass insert` refuses an entry that exists. To replace a token, `opensesame
pass rm connections/acme/vercel` first.

## 3. Declare the connection

In `.env.schema`, next to where you run the command:

```text
# @required @sensitive
VERCEL_TOKEN=opensesameConnection(conn://acme/vercel, projection=legacy-token, paths="/v2/user", methods="GET")
```

- `paths=` is a comma-separated list of absolute prefixes, matched on segment
  boundaries (`/v2/user` admits `/v2/user/x`, never `/v2/user-private`).
  `methods=` is required beside it. There is no default and the root is not a
  scope ([Scope of a surrogate](plugins.md#scope-of-a-surrogate)).
- `opensesame dev --agent resolve` shows what a run will do with the line. It
  prints a shaped placeholder (`ostest_…`) and the scope, never a token.

## 4. Run

```bash
opensesame dev --agent run -- \
  sh -c 'curl -sS https://api.vercel.com/v2/user -H "Authorization: Bearer $VERCEL_TOKEN"'
```

It asks for the store passphrase, or takes `OPENSESAME_STORE_PASSWORD`. The
`sh -c` is there so that `$VERCEL_TOKEN` is expanded in the child, where it is
the surrogate, and not in your shell, where it is not set. A tool that reads
`VERCEL_TOKEN` itself needs nothing around it.

## What the child sees

`dev run --agent` starts the plugin, which answers with the child's
environment. Printed from inside a run:

```text
VERCEL_TOKEN=osr_7858feac80e8045b207766c3d8238854
HTTPS_PROXY=http://opensesame:<run secret>@127.0.0.1:<port>      (also HTTP_PROXY, https_proxy, http_proxy)
SSL_CERT_FILE=<config dir>/plugin-state/surrogate-proxy/runs/<run id>/ca.pem
                                                                  (also NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE,
                                                                   CURL_CA_BUNDLE, GIT_SSL_CAINFO)
NO_PROXY=localhost,127.0.0.1,::1                                  (also no_proxy)
```

The token is in none of it, in no argument, and in no file. The child gets no
`OPENSESAME_STORE_PASSWORD`. The token travels once, from the store to the
plugin, on the plugin's stdin pipe, inside the run spec. The surrogate and the
proxy credential live for this run only.

A client that ignores `HTTPS_PROXY` holds a string that works nowhere. That
keeps the token safe. It does not stop the client reaching the network some
other way: confining the network is the sandbox's job.

## What a request does

| The child sends | Result |
|---|---|
| `GET https://api.vercel.com/v2/user` with the surrogate | `200`. The provider receives `Authorization: Bearer <token>` and never an `osr_` value |
| `POST /v2/user`, `GET /v9/projects`, `GET /v2/user-private` | `403 request refused by the credential broker`. The token is not placed. Recorded as `surrogate.out_of_scope`. The run goes on |
| No surrogate, a guessed one, or one from an earlier run | The same `403` with the same words |
| The surrogate to any other host | The same `403`, then `surrogate.misdirected`: the run is revoked, the child is stopped, `opensesame` exits `77` |
| Any use after a revocation | The same `403`, recorded as `surrogate.revoked` |

The child is told one sentence whichever fence it hit, so probing teaches it
nothing about which one that was. The detail is in the notices:

```bash
opensesame plugins notices surrogate-proxy
```

```json
{ "notices": [
  { "event_type": "surrogate.misdirected", "severity": "error",
    "summary": "a surrogate for vercel was sent to a host its provider does not use: collect.evil.test" },
  { "event_type": "surrogate.out_of_scope", "severity": "warning",
    "summary": "a surrogate for vercel was used outside its method and path scope: POST" } ] }
```

A notice never carries a surrogate or the token.

## Ending a run, and revoking

| What happens | Effect |
|---|---|
| The child exits | `opensesame` closes the plugin's stdin. The plugin revokes the surrogate, stops the listener, deletes the run's CA file and exits. Exit status is the child's |
| A tripwire (`surrogate.misdirected`) | The same, at once: the child is killed first, `opensesame` prints the line below and exits `77` |
| Ctrl-C | It goes to `opensesame` and the child together. Both exit and the proxy refuses connections at once |
| `kill <opensesame pid>` | The kernel closes the pipe and the run ends: the proxy refuses connections at once. The **child is not stopped**; it keeps a string that no longer works. Stop it too |
| `opensesame plugins disable surrogate-proxy` | The next run delivers placeholders. A live run is not touched |
| 12 hours | The run's TTL |

```text
opensesame: surrogate.misdirected: a surrogate from this run was sent to a host that is not its provider's; the run's surrogates are revoked (1) and the child is stopped
```

Revoking a surrogate does not change the token. To retire the token itself,
rotate it at the provider and `pass rm`, then `pass insert`, the entry.

## When it does not run, or runs without a surrogate

| Situation | What you see |
|---|---|
| Plugin not installed, or off | `opensesame: surrogate delivery is available as an optional plugin ('opensesame plugins install surrogate-proxy --from <path-or-https-url> --sha256 <hex>'); delivering placeholders`. The child gets `ostest_…` and the store is not opened |
| No sealed entry for the connection | `opensesame: VERCEL_TOKEN has no token to redeem: store one with 'opensesame pass insert connections/acme/vercel' (this provider draws none from a local tool)`, then `the surrogate-proxy plugin brokers none of these connections; delivering placeholders`. The child gets `ostest_…` and no proxy |
| The entry cannot be read (wrong passphrase) | The run fails: `the sealed entry connections/acme/vercel (for VERCEL_TOKEN) cannot be read: …`. The child does not start |
| The plugin changed since it was pinned | The run fails: `the surrogate-proxy plugin no longer matches its install pin; reinstall it or run 'opensesame plugins disable surrogate-proxy'`. There is no fallback to placeholders |
| No `paths=` | The plugin refuses: `VERCEL_TOKEN has no bounded scope. Declare what the child may reach on its env-spec entry, for example paths="/repos/acme,/user" and methods="GET"`. Nothing is issued |
| `paths=` without `methods=` | The schema fails: `VERCEL_TOKEN cannot be delivered: paths= needs methods= beside it: …` |
| A connection that is not `vercel` or `github` | Keeps its placeholder and no proxy is set: the plugin has no egress rule for it. The run says so, `opensesame: AWS_TOKEN will keep its placeholder: the surrogate-proxy plugin brokers no 'aws' connection, so a stored token would not be used`, whether or not the store holds an entry, and the store is never opened for it |

GitHub works the same way with no `pass insert`: the plugin takes its token
from `gh auth token`.

## Check it on your machine

```bash
pnpm test:proxied-run     # scripts/test/proxied-run-test.sh
```

It builds the plugin's **test** build (cargo feature `upstream-override`),
installs it into a throwaway home through `plugins install` with its pin,
seals a dummy token with `pass insert`, and runs `dev --agent run` with a child
that goes through the proxy to a recording TLS server standing in for
`api.vercel.com`. It asserts every row of the tables above and that the dummy
token is in no output, file or process command line or environment it can
read. It needs `cargo`, `node`, `git` and a resolvable `@env-spec/parser`:
`pnpm install`, or `OPENSESAME_E2E_ENVSPEC_DIR=<dir holding
node_modules/@env-spec/parser>`. The bridge is an ES module, so `NODE_PATH`
does not help. Linux only for now.

The test build is the only one that can be aimed at another server, with
`OPENSESAME_SURROGATE_TEST_UPSTREAM=api.vercel.com=127.0.0.1:<port>,ca=<ca.pem>`.
A shipped build has neither the variable nor the code for it
(`crates/surrogate-proxy/tests/shipped_build.rs`), and the test build prints
`TEST BUILD` on stderr. Never give it a real token.

Aimed at a Vercel emulator that serves TLS for `api.vercel.com`, the same
commands as above return the emulator's `GET /v2/user` answer, and the
emulator's own request log shows one call per in-scope request and none for
the refused ones. An emulator that does not check `Authorization` answers `200`
whatever it is sent, so it shows that the call arrived, not which token was
on it. The recording server in the test is what proves that.

## What this does not do

- It brokers `vercel` (a sealed entry) and `github` (`gh auth token`). Any
  other connection keeps its placeholder.
- It works for clients that honor `HTTPS_PROXY` and a CA-bundle variable.
  `curl` and Node are exercised here. A client that pins its own certificates
  fails to connect. The Vercel CLI itself has not been run against it.
- While the run lives, the token is in the memory of `opensesame` (briefly) and
  of the plugin. A process of yours that may attach to those processes can
  read it.
