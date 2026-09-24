# examples/

Small, runnable integrations that use OpenSesame from the outside, through the
same SDKs a third party would. Read one when you want to see what integrating
takes; run one when you want to watch a flow end to end.

Every example is a pnpm workspace package named `@opensesame/example-<name>`,
has its own tests, and runs against a local Identity API on `:8788` unless it
says otherwise. Start that first:

```bash
pnpm --filter @opensesame/mock-upstream-idp dev &
OPENSESAME_ENV=development pnpm --filter @opensesame/control-plane start
```

## Relying parties — "Sign in with OpenSesame"

| Example | What it shows | Run |
|---|---|---|
| [`rp-alpha`](rp-alpha) and [`rp-beta`](rp-beta) | Two React apps signing in through `@opensesame/sdk-browser`. Side by side they show **pairwise subjects**: the same person gets a different, unlinkable `sub` at each site. | `pnpm --filter @opensesame/example-rp-alpha dev` (`:5174`), `…-rp-beta dev` (`:5175`) |
| [`static-rp`](static-rp) | A genuinely static site — no backend, no client secret. The browser talks to the token endpoint directly with an origin-derived client id and PKCE ([ADR 0050](../docs/adr/0050-origin-profile-static-site-issuer.md)). Run on two ports to see pairwise isolation across origins. | `pnpm --filter @opensesame/example-static-rp dev` (`:4101`) |
| [`siop-rp`](../apps/example-siop-rp) | A relying party that treats the Pages app as a **Self-Issued OpenID Provider** (SIOPv2): the subject is a key thumbprint, not an account. Read its trust-model table before copying it. It lives at `apps/example-siop-rp` because the `open-sesame` Vercel project deploys it from that path. | `pnpm --filter @opensesame/example-siop-rp dev` |

## Agents

| Example | What it shows | Run |
|---|---|---|
| [`agent`](agent) | An agent registering anonymously, publishing `auth.md` and an agent card, then polling while a person claims it. | `MOCK_AGENT_FLOW=1 pnpm --filter @opensesame/example-agent start` |
| [`static-agent`](static-agent) | A static origin that advertises OpenSesame as its authorization server through `/auth.md` and `/.well-known/oauth-protected-resource` ([ADR 0092](../docs/adr/0092-auth-md-agent-registration.md)). | `pnpm --filter @opensesame/example-static-agent dev` (`:4103`) |

## Headless clients

| Example | What it shows | Run |
|---|---|---|
| [`headless`](headless) | RFC 8628 device login from a machine with no browser, through `@opensesame/sdk-cli`. | `MOCK_DEVICE_FLOW=1 pnpm --filter @opensesame/example-headless start` |

`MOCK_*` variables swap the network for an in-process mock, so the agent and
headless examples run with no Identity API at all.

`pnpm dev` at the repository root starts `rp-alpha`, `rp-beta` and
`static-rp` alongside the Identity plane.

## Rules for examples

- Depend only on SDK and contract packages (`sdk-*`, `static-auth`,
  `agent-protocols`, `contracts`, `os-domain`, `siop-v2`) — never on an app or
  on `app-core`. If an example needs something the SDKs do not offer, that is
  an SDK gap.
- Ship no secrets. Static examples are public clients.
- Keep a `README.md` that says what the example demonstrates and how to run it.
