# ADR 0023 — MCP Bearer profile vs DPoP

## Status
Accepted

## Context
MCP Authorization (2026-07-28) specifies Bearer presentation for tool servers. OpenSesame task profiles require DPoP-bound tokens with replay protection.

## Decision
Map MCP to profile `mcp-authorization-2026-07-28-bearer` with `TokenPresentation::Bearer` minimum. Do **not** downgrade OpenSesame task DPoP profiles to Bearer for MCP convenience. Inbound MCP bearer tokens are validated for audience/resource only; they are **never** forwarded as downstream credentials (`opensesame-protocol-mcp` rejects passthrough).

## Consequences
MCP integrations use the protocol-mcp adapter. Task-secured broker paths remain on `opensesame-task-dpop-rfc9449-v1`. Profile confusion (Bearer where DPoP required) fails closed.
