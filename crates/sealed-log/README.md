# opensesame-sealed-log

An encrypted, rotating log file ([ADR 0155](../../docs/adr/0155-logs-and-events-carry-no-secrets.md)).

A log a process writes for itself (the daemon's `~/.opensesame/daemon.log`, a
Host run with `OPENSESAME_LOG_FILE`) rests sealed. Every line is sealed on its
own, `osl1.` + base64url(24-byte nonce ‖ XChaCha20-Poly1305 ciphertext and tag),
under a key kept apart from the file, so a torn write costs one line, a reader
can start anywhere and rotation needs no re-encryption. The TypeScript services
write the same format (`packages/observability`, `sealed-log.ts`); both open the
lines in [`spec/conformance/sealed-log-vectors.json`](../../spec/conformance/sealed-log-vectors.json).

Lines are scrubbed before they arrive (`opensesame-redaction`'s `ScrubWriter`);
sealing is what keeps the rest of what a log says from resting in the clear.

A configured sealed log that cannot be opened or keyed refuses to start the
process. It never falls back to a plaintext file or to stdout.

## Where it fits

- **Used by:** [`opensesame-cli`](../../apps/cli) (`src/log_sink.rs`: `OPENSESAME_LOG_FILE`
  for the Host, worker and daemon; `daemon start` and `daemon logs`).
- **Builds on:** [`opensesame-redaction`](../redaction) (a plaintext line read
  back is scrubbed rather than trusted).

## Surface

| Item | What it does |
|---|---|
| `open_sink(log, key_override)` | Load or create the key (mode 0600, published atomically, never overwritten), seal a legacy plaintext log in place, open the file owner-only and return a shareable sink. |
| `SealedLogSink::writer()` / `SealedLogWriter` | An `io::Write` that seals each complete line; plugs into `ScrubMakeWriter`. |
| `SealedLogFile` | One file: owner-only (a wider one is narrowed), rotating whole files, 8 MiB × 3 by default. |
| `read_tail(path, key, n)` | The last `n` lines, decrypted; a line that does not open reads as `UNREADABLE`. |
| `seal_existing(path, key)` | Seal a plaintext log in place, atomically, scrubbing as it goes. |
| `LogKey::load_or_create` / `load` | `load` never creates, so asking for logs never mints a key nothing was sealed under. |
| `key_path_for(log, override)` | `OPENSESAME_LOG_KEY_FILE`, else `<log>.key`. |

## Develop

```bash
cargo +1.88.0 test -p opensesame-sealed-log
```
