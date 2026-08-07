# ADR 0002: Greenfield technology foundations

## Status
Accepted

## Context
Empty repository; prompt greenfield defaults apply.

## Decision
Rust workspace (Axum/Tokio/SQLx), TypeScript/pnpm for web/extension, PostgreSQL production + SQLite local behind traits, OpenFGA, OpenBao, Keycloak profile, Wasmtime WIT, NATS JetStream behind TaskBus, Tailscale + static mTLS mesh adapters.

## Consequences
Provider-specific logic stays in adapter crates. Domain IR never depends on OpenFGA tuple syntax or Keycloak claim names.
