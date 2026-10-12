#!/usr/bin/env node
/**
 * The same two-browser join as `verify-relay-join.mjs`, against the gateway
 * relay profile (`opensesame host run --profile relay`), not the in-process
 * harness. The journeys shard runs the harness. This one needs the binary.
 */

process.env.VAULT_RELAY_LIVE = "1";
await import("./verify-relay-join.mjs");
