/**
 * Key fragments that must never appear in an outbound payload. Matched against
 * a key with case and separators stripped, so `private_key`, `Private-Key` and
 * `PRIVATEKEY` are one denial. Substring matching is intentional: a `userToken`
 * field is exactly as disqualifying as a `token` one.
 */
export const DENIED_KEY_TERMS: readonly string[] = [
  "password",
  "secret",
  "token",
  "totp",
  // An account's login-method secrets (ADR 0172, 0173): a pepper is typed by
  // the person and never stored, a sealed envelope, its OPAQUE record and
  // server setup, and an OPRF key are as good as the password they open, and
  // an API key is a credential.
  "pepper",
  "sealed",
  "oprf",
  "serversetup",
  "registrationrecord",
  "apikey",
  "privatekey",
  "recoverycode",
  "cardnumber",
  "note",
  "items",
  "folders",
  "vault",
  "cookie",
  "authorization",
];
