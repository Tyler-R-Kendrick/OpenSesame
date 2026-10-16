# ADR 0205 — Secret delivery lanes on `run`

- **Status:** Accepted
- **Date:** 2026-10-16
- **Uses:** [ADR 0186](0186-cli-app-integration-reveal.md)

## Context

Issue #786 records Tyler's naming correction for R8 secret delivery: OpenSesame
must use the wrapper name its peers share (`op run`, `infisical run`,
`doppler run`, `bws run`) instead of inventing verbs, and secret references keep
the `scheme://vault/item/field` shape. R8 PR1 (#785) gated plaintext egress,
PR2 (#1232) landed `os://` resolution with masked `run` and `run --mount`, and
PR3 (#1402) landed broker mode as `run --agent-proxy`. This ADR records the lane
model those PRs form, so PR4 and PR5 extend it instead of adding names.

## Decision

1. **One wrapper, four lanes.** `opensesame-id run` / `os run` (native:
   `opensesame password-agent run`) is the only secret-delivery wrapper:
   - **Inject** — `run --env NAME=<ref>` and `env run <file> -- <cmd>` resolve
     `op://` / `os://` references into the child environment; resolved values
     are masked wherever the child prints them.
   - **Mount** — `run --mount NAME=<ref>` gives the child a private temp file
     holding the secret, removed after the run (Doppler `--mount` analogue).
   - **Broker** — `run --agent-proxy --paths NAME=/prefix --methods NAME=GET`
     gives the child scoped `osr_…` surrogates and proxy environment, never
     the credential. It is a mode of `run`, never a standalone `proxy` verb;
     `surrogate-proxy` stays an internal plugin name.
   - **Request** — the single-request lane: a human runs `lease approve`
     (interactive terminal, bounded TTL and uses) and an agent runs
     `request --lease <id>` for one bound private HTTPS call.
2. **Reveal is a lane of its own, for humans only.** Direct plaintext
   (`read`, gated by TTY + `--reveal` + `--desktop` for `op://`, plus the
   ADR 0186 app-integration approval) is not an agent surface. Agents use
   inject, mount, broker, or request; they never reveal.
3. **Approval is out-of-band.** Every `run` lane passes the ADR 0186
   app-integration approval (`ensureReveal` for verb `run`) before any value
   is resolved; a missing daemon, denial, or expiry refuses the run.
4. **PR4 extends, not renames.** A reusable grant for `run` must bind the
   exact assignment set (names, references, and for broker mode the path and
   method scopes), a TTL no longer than the lease ceiling, and a use budget,
   and must be issued only by the same human approval ceremony as
   `lease approve`. Until that grant exists, approval stays per-run.
5. **PR5 renames on the same lanes.** `read` becomes `reveal` and
   `env resolve` is retired in favour of `run --env` / `env run`; the verb is
   part of the CLI ↔ app integration protocol, so the rename lands in the
   conformance spec, both CLIs, and the app in one change.

## Consequences

- No new top-level verbs for secret delivery; reviewers reject a `proxy`,
  `inject`, or similar standalone command.
- PR4 (run grants) and PR5 (rename and retirement) remain open work on #786;
  this ADR is their contract, not their implementation.
