# Live provider verification (ADR 0055)

Google, Microsoft Entra ID, GitHub and Apple are **implemented, not stubbed**. Every leg —
OIDC discovery, PKCE S256, the server-side code exchange, JWKS verification, the generic
OAuth2 leg for providers that issue no `id_token`, and Apple's `form_post` → 303 → GET
re-materialization — runs against the reference IdP
(`apps/mock-upstream-idp`), which is a real HTTP server speaking the real wire protocols with
real cryptography, including GitHub's actual quirks (form-encoded token responses, errors
returned with HTTP 200) and a genuine auto-submitting `form_post` authorize response.

What cannot be exercised in this repository is the handshake with the providers' own servers,
because that needs credentials only the operator can create (and, for Apple, a paid developer
account). **That is the only thing gating live verification**: the code is complete, and there
is nothing to work around in it. This runbook is those steps.

Read `docs/architecture/federated-signin.md` §8–§9 for what the registry and the legs actually
do; this document assumes you have a deployment running and are adding real providers to it.

## Before you start

**One redirect URI, registered once, for every provider:**

```
{OPENSESAME_PUBLIC_URL}/v1/federated/callback
```

That exact string is what you paste into Google's, Entra's, GitHub's and Apple's consoles.
There is no per-provider variant and no wildcard to negotiate.

It is worth knowing why, because the path does not look like the one that completes a sign-in.
Receiving the authorization response and resuming the interaction are two different steps.
Resuming needs oidc-provider's interaction cookie, which is `SameSite=Lax` and path-scoped to
`/interaction/<uid>` — so that step still happens there. *Receiving* needs no cookie at all, so
it happens at the stable URL above, which verifies nothing, stores nothing, and 303s the
browser to the interaction's own callback. Which interaction comes from the `state` value,
which the server prefixes with the interaction id for exactly these legs. Both the GET and the
POST form are served, because Apple returns its response as a cross-site form POST.

Consequences you can rely on:

- The same value works for every sign-in, forever. Google, Microsoft Entra and Apple match a
  registered redirect URI byte for byte, and this one never varies.
- Nothing has to be re-registered when a deployment restarts, scales out, or serves a
  thousand concurrent sign-ins.
- No reverse-proxy rule, rewrite, or edge configuration is required.

Two prerequisites:

- `OPENSESAME_PUBLIC_URL` must be the URL the browser really reaches — it is the origin inside
  the origin-profile client id, the base of the redirect URI, and the default issuer. If it
  disagrees with reality by so much as a trailing scheme or port, the provider will refuse the
  redirect URI you registered.
- Secrets go in the environment, never in git. Every `_CLIENT_SECRET` and `_PRIVATE_KEY` is
  annotated `@sensitive` in `.env.schema`. `pnpm audit:gitleaks` is the backstop, not the
  policy.

**This covers every leg, not just the four providers below.** An organization's own OIDC
issuer and a bring-your-own issuer both use the same URI — there is no per-interaction variant
left anywhere. Earlier revisions of this document said otherwise; that shape could not be
configured against an IdP demanding exact-match registration, which is most of them, so it was
removed rather than documented.

**Organizations need client credentials too.** A tenant configuring `ssoIssuer` should also
set `ssoClientId`, and `ssoClientSecret` when their IdP issues one, from a client they
registered in their own console (the console's *Organization sign-in* page collects both and
shows them the redirect URI to paste). Without them the leg falls back to this deployment's
origin-profile client id, which only an OpenSesame-shaped broker accepts — Okta, Entra ID,
Google Workspace and Auth0 have never heard of an `origin:` client id and answer
`invalid_client`. The secret is write-only: it is stored so it can be presented at the token
endpoint as issued, and no read surface ever returns it.

## Configuration common to all four

```bash
OPENSESAME_PROVIDERS=google,microsoft,github,apple   # only the ones you configure
OPENSESAME_PUBLIC_URL=https://id.example.com
```

Every configured provider's issuer is merged into `OPENSESAME_TRUSTED_UPSTREAMS`
automatically — do not list them twice. A provider entry the configuration cannot satisfy
**refuses the boot**, with a message naming the variable; that is the intended first
verification step for all four.

## Google

Issuer `https://accounts.google.com`, kind `oidc`, confidential client
(`client_secret_post`).

1. Google Cloud console → **APIs & Services → OAuth consent screen**: configure the consent
   screen for your user type and add the `openid`, `email` and `profile` scopes. An
   unpublished app can sign in only accounts listed as test users.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type
   **Web application**.
3. **Authorized redirect URIs**: `{OPENSESAME_PUBLIC_URL}/v1/federated/callback`, spelled
   exactly — Google matches it byte for byte. Nothing else needs to be listed.
4. Copy the client id and client secret.

```bash
OPENSESAME_PROVIDER_GOOGLE_CLIENT_ID=…apps.googleusercontent.com
OPENSESAME_PROVIDER_GOOGLE_CLIENT_SECRET=…            # @sensitive
```

The issuer is a built-in default; set `OPENSESAME_PROVIDER_GOOGLE_ISSUER` only if you have a
reason to override it.

**Confirm.** `GET /v1/federated/providers` lists `{"id":"google","label":"Google",`
`"kind":"oidc","browserCapable":false}` — `browserCapable: false` is correct and expected:
Google's token endpoint serves no CORS, which is why the control plane brokers it. Then sign
in from the hosted login page and check that an `external_identities` row exists with
`kind = 'oidc'`, `issuer = 'https://accounts.google.com'`, `assurance = 'verified'`, and that
the audit trail carries `principal.identity_linked` with `via: "id_token"`.

## Microsoft Entra ID

Issuer `https://login.microsoftonline.com/<tenant>/v2.0`, kind `oidc`, confidential client.

1. Entra admin center → **App registrations → New registration**. Supported account types:
   choose a single tenant. Add a **Web** platform with the redirect URI
   `{OPENSESAME_PUBLIC_URL}/v1/federated/callback`.
2. **Certificates & secrets → New client secret**. Copy the *value* (it is shown once).
3. Note the **Directory (tenant) ID** from the app's Overview page. A verified domain name
   works too.

```bash
OPENSESAME_PROVIDER_MICROSOFT_TENANT=00000000-0000-0000-0000-000000000000
OPENSESAME_PROVIDER_MICROSOFT_CLIENT_ID=…
OPENSESAME_PROVIDER_MICROSOFT_CLIENT_SECRET=…        # @sensitive
```

**Tenant-pinned only.** `common`, `organizations` and `consumers` are refused at boot, and so
is any issuer whose tenant segment contains `{`. This is not a policy choice: those endpoints
publish the literal template `https://login.microsoftonline.com/{tenantid}/v2.0` as their
`issuer`, and exact-match issuer validation can never satisfy a template. Setting
`OPENSESAME_PROVIDER_MICROSOFT_TENANT=common` and watching the boot refuse is a good
five-second check that you are running the build you think you are.

**Confirm.** As for Google, with `issuer = 'https://login.microsoftonline.com/<tenant>/v2.0'`
on the identity row. If the exchange fails with an issuer mismatch, the tenant in your
configuration and the tenant that actually authenticated differ — a guest or personal account
signing in to a single-tenant app is the usual cause.

## GitHub

Issuer `https://github.com`, kind **`oauth2`** — GitHub issues no `id_token`, so this runs the
generic OAuth2 leg (§9) and the authenticated read of `https://api.github.com/user` is the
assurance.

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Authorization callback URL**: `{OPENSESAME_PUBLIC_URL}/v1/federated/callback` — the same
   value as every other provider. (GitHub would also accept a sub-path of whatever you
   register; it does not need to, because this leg sends one fixed URI.)
3. Generate a client secret.

```bash
OPENSESAME_PROVIDER_GITHUB_CLIENT_ID=…
OPENSESAME_PROVIDER_GITHUB_CLIENT_SECRET=…           # @sensitive
```

These two variables are **shared with the Host plane's connection broker**, which uses the
same names for its GitHub OAuth App. One app can serve both planes; if they must not share a
credential, give the planes separate deployments.

Defaults you should not change without a reason: scope `read:user` (a sign-in needs the
profile, not the account) and `subjectField = id`. **The subject is GitHub's numeric `id`,
never `login`.** A login can be renamed and then registered by somebody else, and a subject
that can change hands is an account-takeover path. If you override
`OPENSESAME_PROVIDER_GITHUB_SUBJECT_FIELD`, that is the property you are responsible for.

**Confirm.** The provider list shows `"kind":"oauth2"`. After a sign-in the identity row has
`kind = 'oauth2'`, `issuer = 'https://github.com'` and a numeric `subject`, and the audit row
records `via: "userinfo"`. `email` is present only when the account's profile email is public
— `/user/emails` is deliberately never called, and a GitHub email never counts as verified for
ADR 0057 linking because the shipped descriptor names no `emailVerifiedField`.

## Apple

Issuer `https://appleid.apple.com`, kind `oidc`, `response_mode=form_post`, and a client
secret that is a freshly minted ES256 JWT rather than a stored string.

**Requires a paid Apple Developer Program membership.** This is the one provider where the
account itself, not just the credentials, is a gate.

1. Apple Developer → **Certificates, Identifiers & Profiles → Identifiers**: create an **App
   ID** with the *Sign in with Apple* capability enabled.
2. Create a **Services ID**. Its identifier is your `client_id`. Enable *Sign in with Apple*
   on it and configure:
   - **Domains**: the host of `OPENSESAME_PUBLIC_URL`. Apple requires https and refuses
     `localhost` — there is no local Apple testing.
   - **Return URLs**: `{OPENSESAME_PUBLIC_URL}/v1/federated/callback`, exactly. Apple POSTs
     its response to this URL rather than redirecting to it, which the route serves.
3. **Keys → new key**, enable *Sign in with Apple*, download the `.p8`. **It downloads once.**
   Note the **Key ID** shown after creation and your **Team ID** (top right of the developer
   portal).

```bash
OPENSESAME_PROVIDER_APPLE_CLIENT_ID=com.example.id.service   # the Services ID
OPENSESAME_PROVIDER_APPLE_TEAM_ID=ABCDE12345
OPENSESAME_PROVIDER_APPLE_KEY_ID=XYZ9876543
OPENSESAME_PROVIDER_APPLE_PRIVATE_KEY_FILE=/run/secrets/apple_signin_key.p8
# or, inline (@sensitive):
# OPENSESAME_PROVIDER_APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n…"
```

The server mints the `client_secret` per token request: an ES256 JWT with `iss` = team id,
`sub` = the Services ID, `aud` = `https://appleid.apple.com`, `kid` = the key id, a
ten-minute lifetime, cached in process. Nothing to rotate on a schedule; rotating the key in
the Apple console and swapping the file is the whole operation.

**What to expect on the wire.** Apple returns the authorization response as a cross-site POST,
so a successful sign-in shows **three** requests to this deployment: a `POST` to
`/v1/federated/callback` answered with `303`, then the browser's `GET` to
`/interaction/{uid}/federated/callback` carrying `code` and `state`, then the `303` that
finishes the interaction. That is by design — both the pending cookie and the interaction
cookie are `SameSite=Lax`, so neither is on Apple's POST and both are on the top-level GET
that follows (§8.6, ADR 0055 §4a). If the POST 303s and the GET then answers 400 saying the
sign-in state did not match, the cookie is not reaching the GET: check that
`OPENSESAME_PUBLIC_URL` matches the browser's origin exactly and that no proxy rewrites the
path.

**Confirm.** Identity row `kind = 'oidc'`, `issuer = 'https://appleid.apple.com'`. Apple sends
the name only on the *first* authorization for a given Services ID, and its email may be a
private relay address; neither affects admission, which rests on the subject.

## Verifying the whole set

1. **Boot.** The control plane starts. A misconfigured provider refuses the boot by design —
   read the message, it names the variable.
2. **Catalog.** `curl -s $OPENSESAME_PUBLIC_URL/v1/federated/providers` lists exactly the ids
   you configured, with the right `kind`, and carries **no** issuers, endpoints, client ids or
   secrets. If you see any of those, you are not running this build.
3. **Buttons.** The hosted login page renders one button per provider. A client that sends
   `kc_idp_hint` or `login_hint_provider` gets that provider rendered first and primary —
   never auto-submitted, because an upstream error returns to this page and a self-redirecting
   page would loop.
4. **Round trip.** Complete a sign-in per provider from a fresh browser profile. A brand-new
   user ends as one principal with `state = 'active'`, `assurance = 'verified'`, and an
   `external_identities` row naming the upstream.
5. **Returning user.** Sign in again. The principal id is unchanged and no second principal
   appears. Note that a returning identity gets **no** new provisional cookie on the redirect
   legs — that is correct, not a bug.
6. **Refusal.** Cancel at the provider's consent screen. You should land back on the login
   page able to choose again, not on an error page.
7. **The callback in isolation.** `curl -si "$OPENSESAME_PUBLIC_URL/v1/federated/callback"`
   answers `400` with one sentence, as does any request whose `state` names no interaction.
   That endpoint verifies nothing and stores nothing; it only routes a response to the
   interaction its `state` names, and the exchange still fails closed for anyone who does not
   hold that interaction's pending cookie.

## Rolling back one provider

Remove its id from `OPENSESAME_PROVIDERS` and restart. Its issuer stops being merged into the
trusted allowlist, so its leg answers `untrusted_issuer` and its button disappears. Identity
rows already admitted through it are untouched and keep working if you re-add it — the tuple
is `(kind, issuer, tenant, subject)` and none of those change.

Revoke the credential at the provider as well: removing it from configuration stops this
deployment using it and does nothing about anyone else who has a copy.

## Related

- `docs/architecture/federated-signin.md` §7.1 and §8.6 — the receive/resume split and the
  stable callback
- `docs/architecture/federated-signin.md` §8–§9 — registry, trust fence, OAuth2 leg
- ADR 0055 — provider registry, BYO issuers, organization sign-in
- `.env.schema` — the authoritative variable list and its `@sensitive` annotations
- `docs/operators/local.md` — local stack, where the reference IdP stands in for all four
