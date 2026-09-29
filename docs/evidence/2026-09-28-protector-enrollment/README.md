# Enrolling an age recipient, AWS KMS and Google Cloud KMS from Security

Two real builds walked the same way: **before** is `a04ceb7e` (built in its own
worktree), **after** is this branch. Numbers are read from the browser
(`capture-evidence.mjs`, `count`, `measure` and `report` steps), not from the
diff. Decision: [ADR 0152](../../adr/0152-browser-key-protector-enrollment.md).

| Sheet | What it shows |
|---|---|
| [`1280-add-sheet.png`](1280-add-sheet.png) | The Add sheet, desktop |
| [`1280-add-age.png`](1280-add-age.png) | age recipient expanded |
| [`1280-add-aws.png`](1280-add-aws.png) | AWS KMS expanded |
| [`1280-security-after-age.png`](1280-security-after-age.png) | Security after making an age key |
| [`1280-test-age.png`](1280-test-age.png) | Test on the age recipient |
| [`1280-encryption-tiles.png`](1280-encryption-tiles.png) | Capabilities › Encryption |
| [`1280-connections-aws.png`](1280-connections-aws.png) | Connections › AWS KMS |
| [`1280-connections-yubikey.png`](1280-connections-yubikey.png) | Connections › YubiKey (the page is gone) |
| [`1280-key-vault-ceremony.png`](1280-key-vault-ceremony.png) | The key vault glyph's ceremony |
| [`390-add-age.png`](390-add-age.png), [`390-add-aws.png`](390-add-aws.png) | The same sheets at 390 × 844, coarse pointer |

## Measurements

| | Before | After |
|---|---|---|
| Add sheet — kinds a person can enroll | 3 (Recovery key, Passkey, age passkey) | 6 (adds age recipient, AWS KMS, Google Cloud KMS) |
| Add sheet — expandable choice rows | 0 | 4 |
| Add sheet — checkboxes | 1 (unchecked, the Passkey key did nothing) | 0 |
| Security, with an age key made — rows | 1 | 2 |
| Security — rows with Test / Preferred / Remove | 0 / 1 / 1 | 1 / 1 / 1 (Test and Remove on the age recipient; Preferred on Password only) |
| Capabilities › Encryption — tiles | 4 (YubiKey, AWS KMS, Azure Key Vault Keys, Google Cloud KMS) | 2 (AWS KMS, Google Cloud KMS) |
| Connections › AWS KMS — Prefer keys | 1 | 0 |
| Connections › YubiKey — inputs on the page | 5 (the recipient form) | "Connector not found" |
| Key vault glyph ceremony — choice rows | 4 setup-preference pickers (a cloud choice then asked for "Authorize connection") | 4 Add choices, no preference |
| 390 — sheet fields (height, computed font size) | — | 44 px, 16 px, all of them (age, AWS, Google) |
| 390 — keys in the sheets | — | 44 × 44 (Optional settings summary 161 × 45) |
| 390 — horizontal overflow | — | none |

## Behaviour verified live (attached Vite session, real browser)

`pnpm --filter @opensesame/pages exec vite` on `:5192` (`:5180` was held by
another session), a sealed personal vault, console and page errors watched: none.

| Step | Result |
|---|---|
| Make a new age key | An `age-keygen` file was downloaded (`# public key: …` then `AGE-SECRET-KEY-1…`); the row appears verified; the notice says the identity was saved outside the vault |
| Test with a wrong / right identity | Refused / "Protector proof succeeded" |
| Paste a recipient only | Row is **Untested**; a Test with its identity makes it verified |
| PIN added under Unlock methods | The Vault key protection list now shows it (it was missing until the next unlock's projection); it carries Preferred, no Remove |
| Preferred on Password, then lock | Unlock screen opens on the **Password** tab |
| Preferred on PIN, then lock, and after a reload | Unlock screen opens on the **PIN** tab |
| AWS KMS, provider simulated at the network layer (`page.route`, CORS answered) | `Encrypt` then `Decrypt` sent from the page, SigV4 `Authorization` present; row verified; notice "Enrolled and proven" |
| Google Cloud KMS, same | Token request, then `:encrypt` and `:decrypt` with `Bearer …`; row verified |
| Test on each cloud row | One `Decrypt` (Google: token first); "Protector proof succeeded" |
| Reload and unlock | All four rows are still there |
| Connections › AWS KMS while a protector on that key is enrolled | Keys: Save only; a mark "Protects this vault's key"; Remove absent |
| AWS KMS and Google, **real** provider hosts, placeholder credentials | The request left the page and the provider's refusal was readable: `POST kms.us-east-1.amazonaws.com` → 400 with `Access-Control-Allow-Origin: *`; `POST oauth2.googleapis.com/token` → 400 with the page's origin reflected. The sheet reports "AWS KMS encrypt denied (400)" and "Google refused the service-account credential (400)" |

A success against a real key needs a cloud account this work did not have. The
enrollment and proof are exercised against faithful fakes of each provider's
API (unit tests: real SigV4 signing and the RFC 7523 assertion, verified with
the public key) and, in the browser, against a network-level simulation.

The gates that touch this surface, run against a fresh build: `verify:keyboard`,
`verify:mobile`, `verify:static`, `verify:auth`, and the `minimal-local` and
`family-local` hardened profile builds (no excluded module reachable from an
entry).
