# Model routing (personal)

Exported from OpenSesame `docs/contributing/agent-setup.md` (section "Model
routing (operator profiles)") and the operator runbooks copied beside this
file. This is user-scope policy. It is not an OpenSesame project requirement.
`AGENTS.md` does not record it.

Tier chain, in order:

1. **Grok Build CLI** (tier 1). Subscription auth from `~/.grok/auth.json`.
   Do not use `XAI_API_KEY`. An API-key 403 is misconfiguration, not quota
   exhaustion. The headless wrapper unsets API-key variables before `grok`.
   Baseline model is `grok-4.7`; a newer `grok-*` id from `grok models` wins.
2. **Kimi Code CLI** (tier 2). Only after Grok itself reports a weekly limit
   or quota. Auth is `kimi login` (or `KIMI_MODEL_API_KEY`). Default model
   is `kimi-code/k3`. Plain `KIMI_API_KEY` is ignored by Kimi.
3. **Cursor** (tier 3). When Kimi is also exhausted: Grok 4.7 for security
   and red-team work, Composer or auto otherwise.

Record the tier and why in the PR Provenance section. Never commit auth
files, API keys, or `auth.preferred_method = "api_key"`.

The executable half of this chain is the verbatim script export in
`harness/scripts/`. Those scripts still call `scripts/dev/...` paths inside
an OpenSesame checkout. This PR does not rewire them and does not delete the
OpenSesame copies. A later PR hooks the repo at this dotfiles tree.
