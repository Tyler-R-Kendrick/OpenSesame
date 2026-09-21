# Vault key protection — evidence index

**Gate:** `pnpm verify:key-protection` → `verify-key-protection.json`.

## Runtime matrix

| Mechanism | Product path | Contract/unit | Live |
|---|---|---|---|
| Password / PIN / WebAuthn-PRF | Settings + unlock | yes | virtual PRF where available |
| Recovery key | Settings Add sheet (download once) | yes | n/a |
| Age recipient | age inventory + adapter | yes | n/a |
| Age WebAuthn | Settings Add → Age WebAuthn sheet | yes (fake crypto + real ceremony) | needs authenticator |
| AWS / Azure / GCP KMS | HTTPS transports + SigV4/Bearer; native when CORS blocks | yes (fake + live harness) | blocked without env keys/tokens |
| YubiKey PIV / device-local | Native CLI; browser reports requires-native | yes | blocked without hardware |
| SOPS YAML/JSON | CLI both directions; Formats age armor in browser | yes | needs `OPENSESAME_SOPS_BIN` |
| Rotate / prefer / remove / test | Ceremony sheets (no `window.prompt`) | yes | n/a |

## Traceability

```text
KP-04	protection-view / panel	passed
KP-11	lifecycle + browser-service	passed
KP-14/15	capability-bind AUTH	passed
KP-18/19/20	capsule / MAC / parse	passed
KP-31	cloud envelope + HTTPS transports	passed (live blocked without env)
KP-50	verify:key-protection	passed | live blocked without env
```

## Operator notes

- Add recovery key or Age WebAuthn from Settings › Vault key protection.
- Rotate opens a password FieldShell ceremony.
- Cloud live: set `OPENSESAME_TEST_AWS_KMS_KEY_ARN` + AWS keys, or Azure/GCP key + access token.
- SOPS: `opensesame pass protect sops-encrypt|sops-decrypt` with absolute `OPENSESAME_SOPS_BIN`.
- PIV: `opensesame pass protect` with `age-plugin-yubikey` on the machine.
