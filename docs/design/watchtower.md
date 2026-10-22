# Developer Watchtower

A user-invoked local disk scan for developer secrets. Comparable to
[1Password Developer Watchtower](https://www.1password.dev/watchtower), implemented
in the CLI with no backend, relay or browser extension.

Status: implemented as `opensesame security watchtower`.

## What it scans

### SSH private keys

`~/.ssh`, up to three nested directories, no symlink following, files at most
1 MiB. It recognises:

- OpenSSH private keys (`-----BEGIN OPENSSH PRIVATE KEY-----`);
- PKCS#1 RSA keys;
- DSA and EC private keys;
- encrypted PKCS#8 keys.

It reports:

| Finding | Meaning |
|---|---|
| `insecure_key_type` | DSA, or RSA below 2048 bits |
| `unencrypted` | A supported key stored in plaintext |
| `import_candidate` | A supported, encrypted key not managed by OpenSesame |
| `unsupported` | EC/DSA/PKCS#8 material the current key item cannot import |

OpenSSH keys carry their cipher name and public key type in the public section;
that is read without decrypting the private section. PKCS#1 RSA reads the
modulus length for the 2048-bit floor. No passphrase is requested.

`~/.ssh/.ignore` accepts one wildcard pattern per line (`*`, `?`), with comments.

### `.env` files

Fixed roots under `$HOME`:

`code`, `dev`, `Developer`, `git`, `projects`, `Projects`, `repos`, `src`, `work`.

Files matching `.env` or `.env.<suffix>`, up to four nested directories. The
scan skips `.git`, `node_modules`, `target` and `vendor`, follows no symlinks and
reads at most 1 MiB. A file is reported only when it has at least one
sensitive-looking variable name: token, secret, password, API key, private key,
access key, client secret, credential, auth or webhook.

Only file paths and variable names are reported. Values never enter the report,
the JSON, logs, errors or the process table.

## Usage

```bash
opensesame security watchtower
opensesame security watchtower --output table
opensesame security watchtower --ssh
opensesame security watchtower --env
opensesame security watchtower --home /path/to/home --output json
```

The global `--output` defaults to `json`; `--output table` prints the human
report. `--ssh` and `--env` are mutually exclusive; neither means both.

JSON shape:

```json
{
  "ssh": [
    {
      "path": "/home/ada/.ssh/id_ed25519",
      "keyType": "ssh-ed25519",
      "bits": null,
      "encrypted": false,
      "finding": "unencrypted"
    }
  ],
  "env": [
    {
      "path": "/home/ada/src/app/.env.local",
      "sensitiveVariables": ["API_KEY", "DATABASE_URL"]
    }
  ],
  "summary": { "sshKeys": 1, "envFiles": 1 }
}
```

## What it does not do

- It does not import a key or `.env` file. The person runs a separate explicit
  import.
- It does not delete or rewrite a file.
- It does not compare fingerprints with the vault yet. `import_candidate`
  means "encrypted and supported", not "not already stored".
- It does not scan arbitrary filesystems or follow mounts.
- It does not run on a timer or in the background. The person invokes it.
- It never sends results anywhere.

## Native/PWA split

- **Native CLI**: the scan itself, because it needs local filesystem access.
- **PWA**: may display an imported scan report if one is explicitly opened;
  it never scans a machine it cannot see.
- **No Host/relay**: the command does not call the Host API. It is a local
  read-only utility.

## Delivery

1. SSH key scan and findings (done).
2. `.env` sensitive-name scan (done).
3. Import path: a selected finding can be sent to the existing vault import or
   SSH key UI, with explicit confirmation and no automatic delete.
4. Duplicate detection against vault SSH fingerprints.
5. `--fix` proposal output (`ssh-keygen -p` command) rather than executing it.
6. Optional HTML/JSON report export with the same no-value rule.

## Acceptance

- A DSA key and an RSA key below 2048 bits report `insecure_key_type`.
- An unencrypted supported key reports `unencrypted`.
- An encrypted supported key reports `import_candidate`.
- A key matching `.ssh/.ignore` is skipped.
- Symlinks and files over 1 MiB are skipped.
- A `.env` file with only `NODE_ENV=development` is not reported.
- An `.env` file with `API_KEY=secret` reports the name only.
- The report contains no value, private key, passphrase or signature.
- Running the command twice does not change any file.
