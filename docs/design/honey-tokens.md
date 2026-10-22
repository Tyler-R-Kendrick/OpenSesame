# Self-managed honey tokens

A honey token is a decoy secret planted beside real secrets. It is not a
provider credential: OpenSesame issues a synthetic proxy key, and any use
through the surrogate proxy is a critical tripwire. No AWS account,
CloudTrail trail, provider-native honey-token feature or backend is involved.

## Token shape

```text
osr_hny_<32 lowercase hex id>_<32 lowercase hex secret>
```

- `osr_` is the reserved surrogate marker.
- `hny_` selects the honey-token path.
- The id is public and is the notice subject; the secret only makes the
  planted value unguessable. A notice never carries the secret or the full
  token.
- The token is self-contained. The proxy does not need a registry to recognise
  it, and the PWA does not need to write a native daemon file.
- The PWA stores issued records in the vault's sealed local store
  (`settings.honey-tokens.v1`) so the person can copy a token again, see
  whether it is active or triggered, revoke it, or reset it.

## Detection

The existing surrogate proxy sees `osr_` values in methods, headers, the
request target and the body. `honey_token_id` recognises the reserved shape
before normal surrogate admission. A match:

1. never forwards the request;
2. returns the same client refusal as any other surrogate;
3. writes `surrogate.honey_token`, severity **critical**, subject kind
   `honey_token`, subject id the public token id.

The PWA reconciles the plugin's recent notices by that id. A notice for an id
this vault does not hold is ignored; a forged reserved-prefix value can make
noise, but it cannot turn a different record into a trigger.

## Scope and limits

- Detection covers clients that use the surrogate proxy. A token used directly
  against a provider is just an invalid synthetic key; the provider cannot
  report it. This is the synthetic-proxied-key tradeoff and is intentional.
- The proxy is optional for issuing and required for detection. The panel is
  part of the optional feature section, so it is drawn once a daemon is
  paired; without the proxy, tokens can still be issued and planted, but no
  use is observed.
- The token is a decoy, not a credential. It grants no authority, opens no
  vault and reaches no upstream.
- A triggered token remains visible; revoke it to disable the record, or reset
  it after the incident is investigated. Resetting does not change the token.
- The PWA shows at most the daemon's bounded recent notice list. Native
  `opensesame plugins notices surrogate-proxy` remains authoritative for the
  sealed local evidence file.

## HoneyVault

The retired-password response `synthetic_decoy` opens an independently keyed
HoneyVault seeded with six synthetic credentials (AWS, Stripe, GitHub,
Cloudflare, Postgres and an internal API). The credentials use the normal
proxy-key shape `osr_c0de<28 hex>`; nothing in the value says "honey". The
reserved id namespace makes the proxy report them as decoys. Arming / opening
registers those credentials in the owner's sealed honey-token store; the
decoy only carries the token text.
Using one through the surrogate proxy raises the same critical
`surrogate.honey_token` notice as any other planted token, so the owner sees
it after leaving the decoy.

The mode reuses the existing duress compartment and effect machinery: the
plan is sealed under the code, and the effect adds ordinary account items to
the ephemeral decoy session. No protected-vault plaintext is copied, and the
decoy is wiped when it locks.
