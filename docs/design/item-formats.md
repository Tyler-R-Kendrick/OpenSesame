# Item formats

An item type describes fields. It does not describe an issuer. Several kinds
of secret have a public, checkable shape anyway: a payment card ends in a Luhn
check digit, an IBAN has a mod-97 check, a VIN has a weighted check character,
a TOTP seed is base32, a provider API key carries a prefix and length its
issuer chose. `@opensesame/vault-core` keeps those algorithms in
`item-formats/`: one parser, one optional generator, and an explicit coverage
decision for every built-in and optional item type.

The manifest stays inert (ADR 0087). A definition still names fields from the
closed catalogue; it cannot carry a regex, a validator, or a URL. The formats
are platform code keyed by the built-in type id, so an untrusted manifest
cannot add execution.

## API

| Export | Meaning |
|---|---|
| `bestItemFormat(value)` | The strongest parser match, or `null`. |
| `detectItemFormats(value)` | Every match, strongest first. Useful when one value fits two types (a 16-digit number can be a card or a gift card). |
| `parseItemFormat(typeId, value, formatId?)` | Parse a value as a named item type; preserves the value rather than normalising a secret. |
| `generateItemFormat(typeId, options?)` | Produce synthetic field values that parse again. `formatId` chooses one of a type's formats; `random` and `now` make tests deterministic. |
| `generateItemValues(typeId, options?)` | The generated fields alone. |
| `itemFormatCoverage(typeId)` | `parser+generator`, `parser`, or `unsupported` with a reason. |

Generation is synthetic. It uses `.test` domains, test key prefixes, and
random values; it never contacts a provider, proves a credential is live, or
turns a test value into a working account credential.

## What is checked

| Item type | Check or shape | Generator |
|---|---|---|
| `card` | Luhn checksum, known brand and length | Yes (test-shaped PAN, expiry, CVV) |
| `bank-account` | IBAN mod-97; ABA routing checksum | Yes |
| `authenticator` | `otpauth://` or an uppercase base32 seed | Yes |
| `token` | Three-segment JWT with JSON header and payload | Yes |
| `api-key`, `api-credential` | Supabase `sbp_`/`sb_secret_`, GitHub, GitLab, AWS, Slack, Stripe, Anthropic, OpenAI, Google, npm, Hugging Face, Replicate, Groq, Perplexity, xAI, Linear, Notion, Airtable, Figma, Shopify, DigitalOcean, SendGrid, Mailgun, PyPI, Sentry, Twilio, PostHog, PlanetScale, Resend, Doppler, 1Password, HashiCorp Vault, Pulumi, and a synthetic generic key | Yes, per format |
| `database` | Parsed connection URL (PostgreSQL, MySQL/MariaDB, MongoDB, Redis, SQL Server) | Yes |
| `server` | `ssh://` URL and host/port | Yes |
| `vehicle` | 17-character VIN with the ISO 3779 check digit | Yes |
| `crypto-wallet` | EVM address with EIP-55 checksum | Yes |
| `passkey` | Base64url WebAuthn credential id | Yes (shape only) |
| `software-license` | UUID licence key | Yes |
| `email-account` | Email address | Yes |
| `wifi` | `WIFI:` QR payload with escaped SSID/passphrase | Yes |
| `gift-card` | Numeric card number with no universal issuer checksum | Yes |
| `backup-codes` | Four or more code lines | Yes |
| `secret`, `password` | Exact named-type parse; no automatic detection | Yes (opaque value) |
| `ssh-key` | OpenSSH public key wire structure; OpenSSH, PKCS#1, PKCS#8 and SEC1 private keys | Yes (synthetic ed25519 public key) |
| `certificate` | OpenSSL PEM certificate or chain; parses CN, SAN, expiry and serial | Parser only |
| `passport` | ICAO 9303 TD3 MRZ with check digits | Yes (synthetic specimen) |
| `identity-document` | ICAO 9303 TD1 MRZ with check digits | Yes (synthetic specimen) |

Everything else is explicitly unsupported with a reason. Postal addresses,
free prose, names, membership numbers, national identity numbers outside an
ICAO MRZ, driving-licence numbers, health-plan member ids, client credentials,
and policy records do not have a universal secret shape. A parser that guessed
at them would be less honest than the field label.

## Pitfalls

- **Issuer prefixes are not verification.** A matching Supabase PAT is
  well-formed; only Supabase can say whether it is live. The UI calls the
  result a recognized format.
- **Overlapping shapes are expected.** A 16-digit number that fails Luhn can
  still be a gift card; a provider key can also be a generic token. Return all
  matches and choose by context rather than discarding the weaker one.
- **Do not generate live-looking keys into a real vault.** Generation exists
  for tests, fixtures, and explicit synthetic samples. The generic API key uses
  the `opensesame_test_` prefix, and provider-shaped generators stay in the
  test plane.
- **Host plane.** The manifest parser has a Rust twin; these format algorithms
  are currently the client-plane `vault-core` module. Adding a host consumer
  should add its own parser against the same table and conformance vectors
  rather than moving a secret through JavaScript to reuse this one.
