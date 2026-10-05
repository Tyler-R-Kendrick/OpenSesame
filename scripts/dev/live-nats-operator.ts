/**
 * pnpm dev:live-nats — a nats-server that live sessions mint credentials for
 * (ADR 0167). Writes, into `--out` (default `.cache/live-nats`):
 *
 * - `live-sessions.conf` — nats-server in operator mode, the WebSocket
 *   listener at `--websocket` (default 127.0.0.1:4223), `wss://` when
 *   `--tls-cert` and `--tls-key` are given;
 * - `live-sessions.mint.json` (0600) — the account public key and signing
 *   key the owner puts in Settings › Live sessions › Routes;
 * - `operator.nk` (0600) — the operator's seed; keep it offline.
 *
 * Run it once per server. The logic is
 * `packages/app-core/src/lib/live/nats-operator.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { liveNatsOperator } from "../../packages/app-core/src/lib/live/nats-operator.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const { values } = parseArgs({
  // pnpm passes its own `--` through.
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    websocket: { type: "string", default: "127.0.0.1:4223" },
    listen: { type: "string" },
    "tls-cert": { type: "string" },
    "tls-key": { type: "string" },
    out: { type: "string", default: path.join(root, ".cache/live-nats") },
    json: { type: "boolean", default: false },
  },
});
const cert = values["tls-cert"];
const key = values["tls-key"];
if (Boolean(cert) !== Boolean(key)) {
  process.stderr.write("--tls-cert and --tls-key go together.\n");
  process.exit(2);
}
const made = await liveNatsOperator({
  websocket: values.websocket,
  ...(values.listen ? { listen: values.listen } : {}),
  ...(cert && key ? { tls: { cert, key } } : {}),
  watcher: values.json,
});
const out = path.resolve(values.out);
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const config = path.join(out, "live-sessions.conf");
const mint = path.join(out, "live-sessions.mint.json");
fs.writeFileSync(config, made.config, { mode: 0o644 });
fs.writeFileSync(mint, `${JSON.stringify(made.mint, null, 2)}\n`, {
  mode: 0o600,
});
fs.writeFileSync(path.join(out, "operator.nk"), `${made.operatorSeed}\n`, {
  mode: 0o600,
});
const scheme = cert ? "wss" : "ws";
if (values.json) {
  // For a harness: where the files went, and a credential to watch with.
  process.stdout.write(
    `${JSON.stringify({ config, mint: made.mint, watcher: made.watcher })}\n`,
  );
} else {
  process.stdout.write(
    [
      `nats-server -c ${config}`,
      "",
      "Settings › Live sessions › Routes › NATS server:",
      `  Server:              ${scheme}://${values.websocket}`,
      "  Sign-in:             Per session",
      `  Account public key:  ${made.mint.account}`,
      `  Account signing key: in ${mint}`,
      "",
    ].join("\n"),
  );
}
