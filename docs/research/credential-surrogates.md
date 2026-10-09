# Credential surrogates: prior art and what OpenSesame takes from it

> Status (2026-10-08): the two adapters this note points at now exist as the
> optional plugins of ADR 0150 §7: the proxy (`crates/surrogate-proxy`, binary
> `opensesame-surrogate-proxy`) and the companion autofill extension
> (`apps/browser-extension-autofill`). The survey below is as of 2026-09-28.

Research behind [ADR 0150](../adr/0150-surrogate-credentials-at-the-last-hop.md).
Surveyed 2026-09-28. This note covers one pattern: the untrusted side holds a
stand-in, and a trusted boundary puts the real credential on the wire.

## The systems

| System | Where the stand-in lives | Where the swap happens | Binding | Response side | Notes |
| --- | --- | --- | --- | --- | --- |
| Meta Muse: `hatch-authd` + Sentinel | runtime cell and workers hold a *surrogate* minted by authd | Sentinel at the network boundary, after the concrete request is approved | per-service ACLs in authd; L4+L7 egress evaluation; payment credentials bound to merchant, amount and time | not described | "Propose then permit": Sentinel is the sole permission authority. Meta says prompt injection "remains an open problem". |
| Anthropic sandbox-runtime (`mask` + `injectHosts`) | per-session sentinel in env or files | TLS-terminating proxy with an ephemeral CA | the credential's `injectHosts` | not described | Open issue: substituting inside HTTP Basic (base64), needed for git over HTTPS. |
| agent-glovebox egress gateway | placeholder in env | `authorization` / `x-api-key` headers only | domain family plus one label below | not described | Refuses to send a placeholder over plain HTTP, and refuses spliced tunnels at startup. |
| Vercel Sandbox credential brokering | nothing: headers are injected | gateway, matching on domain | network policy | — | Injected headers overwrite whatever the agent supplied. |
| E2B `network.rules` (beta) | nothing | gateway header injection | host match | — | Plain environment variables are documented as "not private in the OS". |
| Infisical Agent Vault | `__NAME__` placeholder | proxy rewrites URL path or query | single-level wildcard hosts | none | Trust-the-proxy; HTTP/2 disabled. |
| Fly.io Tokenizer | secret sealed to the proxy's Curve25519 key, sent in `Proxy-Tokenizer` | stateless proxy | per-secret allowed hosts or regex | — | Processors cover header injection, HMAC signing and JWT-bearer exchange. The client must be modified. |
| 1Password Secure Agentic Autofill (Browserbase) | the agent never holds it | the 1Password extension in the remote browser fills after human approval over a Noise-based channel | per-item human approval | — | Fill, not substitution: the value does reach the page. |
| Horcrux (Li & Evans, arXiv:1706.05085) | dummy credentials autofilled into the DOM | trusted component rewrites the POST before encryption | form submission | — | Works on over 98% of tested forms. Fails where the page transforms the field client-side. |
| Nonce replacement (arXiv:2509.02289) | random nonce autofilled | the *browser* swaps it before transmission | submission | — | Proposes a browser change. Counts 4,169 extensions that can read any request body, 1,410 of them unable to inject scripts. |

## Where they disagree, and why it matters

1. **Find-and-replace versus a declared site.** Most of these systems rewrite
   the placeholder text wherever it appears on a bound host. That leaves a
   reflection oracle open on the bound host itself. The agent puts the
   placeholder in something the host stores and returns (a gist, an issue, a
   profile field), sends a valid header beside it, and reads the credential
   back. Only systems that fix the site, such as glovebox's header-only swap,
   close it. ADR 0150 goes one step further. It never rewrites the text at
   all: the surrogate selects a credential, and the broker writes it into the
   provider's own site.
2. **Nobody describes response scrubbing.** An upstream that echoes the
   presented header (debug routes, error messages) returns the real
   credential through the very proxy meant to protect it. OpenSesame's
   invoke-through had the same gap until ADR 0150 §4.
3. **Nobody uses the stand-in as a tripwire.** A surrogate sent to the wrong
   host has only one explanation: something copied it. Each system simply
   declines to substitute. ADR 0150 §5 also reports it.
4. **Caller binding.** Only Muse, bound per VM, ties the stand-in to the
   presenting process. A stand-in copied into a transcript or a model
   provider's retention and replayed through the same proxy is otherwise live.
5. **`HTTPS_PROXY` is advisory.** Every proxy design that relies on it is
   bypassable. With substitution, bypass fails *safe for confidentiality*: the
   bypassing process holds only a dead string. What bypass does defeat is
   detection. ([Zujkowski](https://williamzujkowski.github.io/posts/2026-07-02-agentic-ai-sandbox-secret-proxying-gap/)
   makes the broader case that proxying prevents theft, not misuse.)

## Browsers specifically

- Chromium's Manifest V3 `declarativeNetRequest` can modify request and
  response headers, never bodies. `webRequest`'s `requestBody` is read-only
  everywhere. An extension therefore cannot do Horcrux's rewrite. What remains
  is a local TLS-terminating proxy the whole browser trusts, and ADR 0150 §6.4
  rejects that.
- DOM-based extension clickjacking (Marek Tóth, DEF CON 33, August 2025) hid
  password-manager autofill UI under page overlays. All eleven managers
  tested were vulnerable, across about 40 million installs, and depending on
  the manager the attack extracted credentials, cards, TOTP codes and
  personal data. The lesson for autofill, which had not been built when this
  was surveyed: the trusted gesture must happen on UI the page cannot draw
  over.

## Sources

- [Meta — How we built safety into Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
- [MarkTechPost — Meta introduces Muse](https://www.marktechpost.com/2026/09/08/meta-introduces-muse-a-personal-ai-agent-that-runs-on-its-own-dedicated-secure-cloud-computer/)
- [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime) and [claude-code#95752 (Basic-auth sentinel)](https://github.com/anthropics/claude-code/issues/95752)
- [agent-glovebox PR 5548 — egress placeholder substitution](https://github.com/AlexanderMattTurner/agent-glovebox/pull/5548)
- [Fly.io — Tokenized Tokens](https://fly.io/blog/tokenized-tokens/) and [superfly/tokenizer](https://github.com/superfly/tokenizer)
- [Agent Vault review](https://www.codeline.co/thoughts/repo-review/2026/agent-vault-credential-proxy-for-ai-agents)
- [The Sandbox Isolates the Agent. It Doesn't Isolate the Secret.](https://williamzujkowski.github.io/posts/2026-07-02-agentic-ai-sandbox-secret-proxying-gap/)
- [E2B issue 1160 — credential brokering](https://github.com/e2b-dev/E2B/issues/1160)
- [1Password — Closing the credential risk gap for browser-use agents](https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents)
- [Horcrux: A Password Manager for Paranoids (arXiv:1706.05085)](https://arxiv.org/abs/1706.05085)
- [Passwords and FIDO2 Are Meant To Be Secret (arXiv:2509.02289)](https://arxiv.org/html/2509.02289v1)
- [The Hacker News — DOM-based extension clickjacking](https://thehackernews.com/2025/08/dom-based-extension-clickjacking.html)
- [Chrome — Replace blocking web request listeners](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests)
