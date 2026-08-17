# ADR 0043: Environment branches for git-backed recoverability

## Status

Accepted (design + Pages UX). UI binds a single env→branch today; multi-env
fan-out lands incrementally on the Host backup actor.

## Context

Operators need **recoverable** sealed vault / project-config ciphertext in GitHub
without making OpenSesame a Doppler clone. Prior art:

| System | Model | What worked | What failed / hurt |
|--------|--------|-------------|---------------------|
| **Doppler** branch configs | Root envs (`dev`/`stg`/`prd`) + inheriting branches; personal `dev_personal` | Clear root vs overlay; promotion is explicit | Inheritance collisions; teams confuse branch configs with git branches; SaaS-held plaintext |
| **Infisical** | Project × environment | Self-host option; GitOps operators | Still centralizes values; Sealed Secrets migration shows Git-encrypted YAML is painful to rotate |
| **SOPS + age** | Encrypt files in git | Diff-friendly structure; client-held keys | No automatic fan-out; humans forget to push; key distribution is the hard part |
| **Bitnami Sealed Secrets** | Cluster decrypts committed ciphertext | True GitOps apply path | Cluster key = SPOF; weak rotation; name/namespace scoping footguns |
| **External Secrets / refs-in-git** | Git stores references only | Avoids secret sprawl in git | Does not satisfy **offline recoverability** when the manager dies |

OpenSesame already has: E2EE vault sync blobs, Host backup actor (ADR 0039),
`SecretConfig.environment`, and sealed-store git. The missing product shape is a
**durable mapping from environment → git branch** that humans understand and
that the backup actor can automate.

## Decision

1. **Branch-environments (not environment-branches as free-form git chaos).**  
   Canonical branches in the private recoverability repo:
   - `env/development`
   - `env/staging`
   - `env/production`
   - `env/<slug>` for custom `SecretConfig` environments  

   The **environment is the product noun**; the branch is the storage address.
   We do **not** invent a parallel “git branch per feature” secrets model like
   Doppler feature branches unless a project explicitly creates a custom env.

2. **One private repo per project (default), many env branches.**  
   Prefer `owner/opensesame-passwords` (or project-named private repo) with one
   branch per environment over one-repo-per-environment. Reasons: fewer GitHub
   App installs to reason about; promotion = merge/cherry-pick of **ciphertext
   trees** under operator control, not value copy in a SaaS UI.

3. **Snapshot layout (ciphertext only).**  
   Actor commits a full tree per branch:
   ```
   README.md
   vault/…          # E2EE sync blobs for that env/project
   connections/…    # sealed authority credentials (deployment key)
   manifest.json    # metadata: project id, env, content versions — no secrets
   ```
   Root `main` may hold only README + pointer metadata; **production recoverability
   defaults to `env/production`**.

4. **Inheritance is explicit, not automatic merge of secret values.**  
   Borrow Doppler’s *root vs overlay* mental model without silent inheritance:
   - `development` may clone from a template once (operator action).
   - Updates to `production` never auto-write into `development`.
   - Agents still never receive `getSecret`; sync targets stay ConnectionRef.

5. **UX binding (Pages).**  
   GitHub recoverability setup lives in **one** Settings panel
   (`#github-backup`): Create App → Authorize → Install → private repo →
   environment → branch. History capability bindings are updated as a side
   effect; operators are not sent through Connectivity for this job.

6. **Failures must be visible.**  
   Missing target, suspended install, or pending outbox depth surfaces in the
   recoverability banner (already required for vault durability).

## Consequences

- Backup actor gains an env/branch selector (initially from the configured
  target branch; later from active project + SecretConfig).
- CLI sealed-store `pass backup` remains for local tombs; Host path is the
  unattended recoverability plane for Pages vault.
- Catalog provider `doppler` stays a SaaS connector — not this model.

## References

- ADR 0039 (event-driven GitHub backup actor)
- ADR 0041 (projects, sync targets, secret changelog)
- Doppler branch configs / root configs docs (inheritance pitfalls)
- Infisical Sealed Secrets migration guidance (why cluster-only decrypt fails
  human recoverability)
