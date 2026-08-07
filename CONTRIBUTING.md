# Contributing

## Prerequisites
- Node.js ≥ 22 (CI uses 22; Node 24+ preferred locally)
- pnpm 9 via Corepack
- Rust 1.88 for the authority plane
- Optional: Docker for Compose / Testcontainers

## Workflow
```bash
pnpm install
pnpm --filter @opensesame/control-plane test
pnpm -r --filter '@opensesame/*' test
cargo +1.88.0 test --workspace --lib
```

Identity CLI binary is `opensesame-id` (Rust authority CLI remains `opensesame`).

## Design rules
- Domain package (`@opensesame/os-domain`) must not import Better Auth, oidc-provider, Hono, Drizzle, or React.
- Prefer mature libraries over NIH protocol code (ADR 0008).
- Do not add Clerk/Marketplace auth as core (ADR 0004).
- Record consequential decisions as ADRs under `docs/adr/`.

## Configuration
Copy from `.env.schema` guidance; never commit live secrets. Development signing keys and claim peppers must be generated outside Git.
