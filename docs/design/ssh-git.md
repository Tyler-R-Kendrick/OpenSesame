# SSH and Git

Competitive contract for [1Password for SSH & Git](https://www.1password.dev/ssh).
The goal is a first-class developer story for SSH keys, agent authentication and
Git commit signing. It is not a claim that the agent exists in this checkout.

Status: target design. This checkout has the `ssh-key` item type and format
parser/generator, Git backup over HTTPS, and an SSH-agent auth-mode label in the
Git connection form. It has no SSH agent, no agent socket, no authorization
prompt, no commit signer and no public-key autofill.

## 1Password capability set

- Generate Ed25519 or RSA (2048/3072/4096) SSH keys.
- Import PKCS#1, PKCS#8 and OpenSSH keys, including passphrase-encrypted keys.
- Public key, fingerprint and private key shown in the item; optional export.
- Public-key autofill on GitHub, GitLab, Bitbucket, Azure DevOps, AWS
  CodeCommit, GCP, DigitalOcean and others.
- SSH agent at `SSH_AUTH_SOCK`:
  - offers every eligible key without `ssh-add`;
  - prompts before a process uses a key;
  - authorization per app, per app + terminal tab, or per request;
  - remember until lock, quit, 4/12/24 hours;
  - approve for all applications;
  - suppresses background IDE/Git prompts;
  - agent activity log.
- Agent config for shared/custom vaults, host/key selection and the OpenSSH
  six-key limit.
- Git commit signing through SSH:
  - `gpg.format=ssh`;
  - `user.signingkey` public key;
  - `commit.gpgsign=true`;
  - `gpg.ssh.program` signer binary;
  - allowed-signers file;
  - global, repository-local and `includeIf` setups.
- WSL and agent forwarding.

## Current OpenSesame gaps

| Capability | Now |
|---|---|
| `ssh-key` item type | Yes |
| SSH key parse/generate algorithms | Parser + synthetic Ed25519 public key |
| SSH private-key import | No first-class flow |
| SSH key generation | No first-class flow |
| Public-key autofill | No |
| SSH agent | No |
| Agent authorization prompt | No |
| Agent activity log | No |
| Git commit signing | No |
| `SSH_AUTH_SOCK` config | No |
| Agent config file | No |
| WSL / forwarding | No |

The `ssh_agent` value in `git-auth-modes.ts` is only a connection-form choice;
there is no agent behind it.

## Runtime boundary

A static PWA cannot be an SSH agent.

- It cannot create a Unix-domain socket or a Windows named pipe.
- It cannot speak the SSH agent protocol.
- It cannot hold a private key across page lifetimes.
- It cannot prompt for a process identity outside its own origin.

The correct split is:

- **Native `opensesame ssh-agent`**: the agent, socket, key access and prompts.
- **Static PWA**: key metadata, public key view, policy, activity and setup
  instructions. It may generate/import a key only by handing it to the native
  store through an explicit local flow; it never claims to serve the socket.

## Key storage

The agent must read the same sealed store it serves. Do not maintain two copies.

Recommended shape:

1. **Native-owned SSH keys.** `opensesame ssh-agent` reads the CLI sealed store.
   The PWA shows an SSH key item by opening a sealed export or by pairing with
   the native agent through a local one-time handoff. The PWA does not keep a
   second private key.
2. **PWA-owned key, explicit import.** If a key is generated in the PWA, it is
   exported once in OpenSSH format after a re-auth and imported into the native
   store. The PWA copy can then be deleted. This avoids drift and an unspoken
   second source of truth.
3. **Never** synchronize a private key through a relay for this feature.

The agent offers only keys explicitly marked `agent: true`.

## Agent design

```text
opensesame ssh-agent
  --socket ~/.opensesame/ssh-agent.sock
  --config ~/.config/opensesame/ssh/agent.toml
  --store <sealed store>
```

- Unix socket mode `0600`, owned by the current user; Windows named pipe with
  the current user's ACL.
- OpenSSH agent protocol: list identities, sign request, extension queries.
- Ed25519 and RSA 2048/3072/4096 only; reject DSA/ECDSA unless later added.
- Private key material stays in the agent process; it never crosses the socket.
- The agent returns signatures, not keys; an SSH key export is a separate,
  re-authenticated operation.
- Peer identity from `SO_PEERCRED` / named-pipe owner + process tree. The prompt
  names the executable, cwd and destination (host/user) when available.
- Bounded concurrent requests, per-key rate limit and a six-key identity
  response cap for OpenSSH servers.
- No key is used while the store is locked.

### Authorization policy

```toml
[agent]
enabled = true
approval = "per_application" # per_application | per_terminal | per_request
remember = "until_lock"      # until_lock | until_quit | 4h | 12h | 24h
background_prompts = "suppress"
activity = true

[[keys]]
id = "ssh_work"
vault = "work"
agent = true
hosts = ["github.com", "gitlab.com"]

[[hosts]]
pattern = "*.internal.example"
keys = ["ssh_work"]
```

- Default: per key, per application; approval lasts until lock.
- Per-request approval never remembers.
- "Approve for all applications" is an explicit key option and is audited.
- A request from an application not in the foreground is suppressed and shown
  as waiting, never silently approved.
- A key is not offered to a host outside its policy.
- The authorization prompt shows the key fingerprint, not a secret.
- 1Password's "approve for all applications" is available only as a deliberate
  per-key choice; the default does not grant it.

### Activity

- One row per request: time, key id/fingerprint, process, operation (auth or
  sign), destination host, decision, duration.
- Encrypted in the sealed store; bounded retention; manual clear.
- No command line, environment, key material, signature or payload.

## Git commit signing

`opensesame git setup` writes a reviewable diff, never silently edits:

```ini
[gpg]
  format = ssh
[user]
  signingkey = ssh-ed25519 AAAA...
[commit]
  gpgsign = true
[gpg "ssh"]
  program = /path/to/opensesame-ssh-sign
```

- `opensesame-ssh-sign` implements the `gpg.ssh.program` protocol and asks the
  agent to sign the commit buffer; it never receives the private key.
- `opensesame git setup` prints the diff for global or repository-local config,
  supports `--dry-run`, and writes an allowed-signers file.
- `opensesame git verify` checks `git log --show-signature` and the allowed
  signers file.
- `opensesame git doctor` reports Git version, `gpg.format`,
  `user.signingkey`, `gpg.ssh.program`, local overrides and email/key mismatch.
- `includeIf` examples are generated, not guessed.
- The signer binary is the only Git integration needed; no shell plugin.

## Public key autofill

- The autofill companion extension fills the public key only, never the private
  key, on SSH key forms for GitHub, GitLab, Bitbucket, Azure DevOps, AWS
  CodeCommit, GCP, DigitalOcean, Linode, Vultr, ngrok and similar.
- A gesture on extension-owned UI arms one fill, same model as the password
  companion. No content script reads the page until armed.
- If the page is not a recognized SSH form, no fill is offered.
- The PWA can copy the public key and fingerprint; no extension is required.

## Native and PWA split

| Capability | Native | PWA |
|---|---|---|
| Generate/import SSH key | Yes | Metadata/export handoff only |
| Private key store | Yes, sealed | No long-lived copy |
| SSH agent/socket | Yes | No |
| Authorization prompt | Yes | No; it cannot identify a process |
| Git signing | Yes | Config copy only |
| Public-key copy/fingerprint | Yes | Yes |
| Public-key autofill | Extension on any browser | Extension or copy |
| Activity log | Native sealed | Read-only view if paired |
| Agent config | Native file | Editor that writes a reviewed file |

The PWA must never show an "Enable SSH agent" key that only writes a config
file. The key belongs to the native surface that owns the socket.

## Outperformance

- No private-key export by default; export requires a fresh re-auth and is
  audited. 1Password offers export as a normal action.
- The prompt names the process, cwd and destination, not just the app.
- Default policy is per-key/per-app, not ambient all-key access.
- Host/key policy is explicit; a key is not offered outside its allowed hosts.
- Background prompts are suppressed and queued, not silently approved.
- Agent activity is local and encrypted; no cloud dependency.
- Git setup is a reviewable diff with a doctor, not a silent global mutation.
- The same ConnectionRef/authority model applies to Git/SSH grants where a
  remote service is involved.

## Delivery slices

1. **SSH key item lifecycle.** Generate/import, fingerprint, public key,
   encrypted private key, agent inclusion flag, export with re-auth.
2. **Native agent.** Unix socket/named pipe, protocol, key selection, process
   identity, lock behavior.
3. **Authorization.** per-app/terminal/request, remember policy, all-app
   opt-in, background suppression, activity.
4. **Git signing.** `opensesame-ssh-sign`, `git setup`, allowed signers,
   doctor, local/global/includeIf.
5. **PWA management.** Key list, public key, policy, agent status, activity
   read-only, reviewed config export.
6. **Public-key autofill.** Extension arm/fill on recognized SSH forms.
7. **Forwarding/WSL.** Documented and tested proxy paths.

## Acceptance

- `ssh-add -l` against the OpenSesame socket lists only keys marked for the
  agent and allowed for the current host.
- `git push` through SSH prompts once per approved application/key and does not
  ask again until lock under the default policy.
- A background IDE request is suppressed and surfaced as waiting.
- A key outside its host policy is not offered.
- `git commit` uses `gpg.ssh.program` and produces a signature verifiable with
  the allowed-signers file and GitHub/GitLab/Bitbucket public key.
- The signer binary never receives private key bytes.
- A PWA page cannot create a socket, cannot claim agent status, and does not
  keep a second private key after handoff.
- Activity records contain no command, environment, key, signature or payload.
- The agent is locked with the vault; no signature succeeds while locked.
