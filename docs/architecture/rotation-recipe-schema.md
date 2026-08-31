# Rotation recipe schema

A recipe is a signed, structural description of how to change a password at one
relying party. It is what a teaching session produces and what the deterministic
tier (T3) replays.

Decision record: [ADR 0076](../adr/0076-autonomous-web-login-rotation.md).
Where recipes come from: [teaching and replay](rotation-teaching-and-replay.md).

## What a recipe is and is not

**Is:** selectors, an event order, a navigation path, wait conditions,
credential-field references, and the site's password composition rules.

**Is not:** a credential, a session, a cookie, an account identifier, a
recording, or anything derived from one user's data. A recipe for
`example.com` is identical for every user of `example.com`, which is what makes
it shareable and what makes review meaningful.

If a proposed field would differ between two users of the same site, it does not
belong in a recipe.

## Shape

```jsonc
{
  "schema_version": 1,
  "rp": "example.com",                    // eTLD+1, lowercase, no scheme
  "change_password_url": "https://example.com/.well-known/change-password",
  "expires_at": "2026-11-30T00:00:00Z",
  "bundle_binding": {                     // drift detection, see below
    "url_pattern": "https://example.com/static/app.*.js",
    "sha256": "9f2c…"
  },
  "composition": {                        // what a valid password looks like here
    "min_length": 12,
    "max_length": 64,
    "required_classes": ["lower", "upper", "digit"],
    "allowed_symbols": "!@#$%^&*",
    "forbidden_symbols": " \"'\\<>",
    "source": "observed"                  // observed | published | curated
  },
  "steps": [ /* step IR, below */ ],
  "success": {
    "kind": "verify_login",               // the only trusted signal
    "confirmation_hints": [               // corroborating, never sufficient
      { "kind": "url_matches", "pattern": "^https://example\\.com/settings\\?changed=1$" },
      { "kind": "text_present", "value": "Your password was updated" }
    ]
  },
  "signature": {
    "alg": "ed25519",
    "key_id": "rcp_…",
    "value": "base64…"
  }
}
```

`max_length` and `forbidden_symbols` are not decoration. A generator that emits
a 40-character password for a site that silently truncates at 16, or that emits
a symbol the site rejects, produces a rotation that appears to succeed and then
fails at next login.

## Step IR

Steps are the transport-neutral instruction set shared by the deterministic
executor and the agent runner (ADR 0076 §8), so a recipe replays identically
across runner implementations.

| Step | Fields | Notes |
|---|---|---|
| `navigate` | `url` | same-origin as `rp` unless `allow_offsite` is set and reviewed |
| `wait_for` | `condition`, `timeout_ms` | condition is a selector, URL pattern, or text |
| `click` | `target` | |
| `fill` | `target`, `value_ref` | **never** a literal value — see below |
| `fill_credential` | `target`, `credential_ref` | `current_password` \| `new_password` |
| `select` | `target`, `option` | |
| `submit` | `target` | |
| `expect` | `condition` | assertion; failure parks the job |
| `step_up` | `channel`, `target` | `totp` \| `email` \| `sms`; requests a code, never stores one |

### Targets are fingerprints, not brittle selectors

```jsonc
{
  "css": "#new-password",                 // preferred, tried first
  "role": "textbox",
  "name": "New password",                 // accessible name
  "input_type": "password",
  "ordinal": 1                            // nth match, for disambiguation only
}
```

The executor tries `css`, then falls back to the semantic fingerprint. A CSS
selector alone does not survive a class-name change, which is the single most
common cause of drift; an accessible name usually does.

### `fill` never carries a literal

`value_ref` names a value the executor supplies — the account identifier from
the vault item, a generated candidate handle, a step-up code just requested. A
recipe that inlined a value would be either user-specific (so not shareable) or
a secret in a shared artifact (so a leak). The schema has no field for one.

## Verification is a fresh login, and nothing else

`success.kind` is `verify_login`, always. The executor performs a fresh login
with the new value in a clean browser context.

`confirmation_hints` are corroborating evidence for the replay overlay and for
drift detection. They can never *substitute* for verification: a site that shows
"Your password was updated" and did not update it is exactly the failure mode
that turns into a lockout, and a text match cannot distinguish the two.

**There is no `verify_old_password_fails` step, and there must never be one.**
Proving the old password no longer works means deliberately failing a login,
which increments lockout counters and looks exactly like credential stuffing.
`RevocationVerified` is satisfied by the site's own change confirmation. This is
ADR 0047's "a test is an oracle" applied to the far end of the credential's
life.

## Drift

`bundle_binding` pins the recipe to the hash of the site's main JS bundle. When
the hash changes, the recipe is *suspect*, not invalid — most bundle changes do
not touch the password form.

Escalation, in order:

1. Bundle hash changed → mark suspect, keep replaying, raise the verification
   bar to full `verify_login` before promotion (it already is; nothing relaxes).
2. Replay fails once → retry once, then park and notify.
3. Replay fails again, or `expect` fails → park the job, enter the teaching
   loop, keep the previous value.

`expires_at` bounds the whole thing. A recipe that has not been canary-verified
within its window is not trusted, however green its last replay looked. Sites
change on their own schedule, not ours.

## Signing and trust

A recipe is trusted only when it is signed, and it is signed only after a
successful canary: a real change to a value we hold, verified by fresh login. A
recipe that has never completed a round trip is a hypothesis.

Trust levels:

| Level | Meaning | Used for |
|---|---|---|
| `candidate` | produced by a teaching session or agent run, unverified | never replayed unattended |
| `canary_verified` | completed one round trip, signed | T3 replay for the user who produced it |
| `corpus` | reviewed and published in the checked-in corpus | T3 replay for everyone |

Promotion from `canary_verified` to `corpus` is an explicit ceremony, reviewed
on the same terms as ADR 0052 §12's relying-party data. Nothing is contributed
by default. Recordings are never shared — only derived recipes.

## Distribution

Corpus recipes ship **checked in and refreshed by a routine**, per ADR 0052 §12:
"the vault does not call a capability service… a lookup is a disclosure". A
runtime fetch of "the recipe for example.com" tells whoever serves it which
sites the user holds accounts on.

Change-password URLs need no corpus at all — RFC 8615 makes
`https://{host}/.well-known/change-password` derivable. Only quirks, composition
rules, and non-conforming sites need data.

Before vendoring anything from `apple/password-manager-resources`, verify its
license against the `deny.toml` allowlist. ADR 0052 §3 draws the line
(implementing from a public specification is fine; copying source is not) and
ADR 0048 §9 records the license trap that makes this worth checking rather than
assuming.

## Review checklist

For anything promoted to `corpus`:

- [ ] no literal values in any `fill` step
- [ ] no user-specific data anywhere in the document
- [ ] every `navigate` is same-origin with `rp`, or `allow_offsite` is set with
      a stated reason (a federated IdP is the legitimate case)
- [ ] no step attempts, retries past, or works around a challenge
- [ ] `success.kind` is `verify_login`
- [ ] no step probes the old password
- [ ] `composition` reflects the site's actual rules, including `max_length`
- [ ] `expires_at` is set and not more than one quarter out
- [ ] canary passed on a real account, with the run recorded
