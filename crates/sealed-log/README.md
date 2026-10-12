# opensesame-sealed-log

An encrypted, rotating log file ([ADR 0157](../../docs/adr/0157-logs-and-events-carry-no-secrets.md)).

A log a process writes for itself (the daemon's `~/.opensesame/daemon.log`, a
Host run with `OPENSESAME_LOG_FILE`) rests sealed. Every line is sealed on its
own in an `osl2.` envelope: a fresh 32-byte data key encrypts the line, and a
purpose-derived wrapping key encrypts that data key. The body is base64url of
wrap nonce (24 bytes), wrapped data key (48), data nonce (24), and ciphertext/tag.
Both operations authenticate `sealed-log.line` and the trusted key-path
namespace. Loaded keys bind the canonical parent directory and key filename;
keys supplied directly through `LogKey::from_bytes` use the empty namespace.
Separate key files have independent bootstrap roots. Reusing a root still
derives different wrapping keys for different namespaces and purposes.

The root remains an operator custody input: a private key file or secret mount,
not another credential encrypted under itself. Restoring ciphertext requires
its original trusted key-path namespace; changing that path requires opening
and resealing under the new namespace. A torn write costs one line, a reader
can start anywhere, and rotation needs no re-encryption.

The TypeScript services write the same format (`packages/observability`). Both
open the shared [envelope vectors](../../spec/conformance/sealed-log-envelope-vectors.json)
and the retained [legacy vectors](../../spec/conformance/sealed-log-vectors.json).
Valid `osl1.` lines are upgraded when a sink opens. Unknown or unauthenticated
sealed lines refuse migration and are displayed as `UNREADABLE` by tail readers.
Existing ciphertext, including rotated generations, never causes a missing
bootstrap root to be replaced automatically.

Lines are scrubbed before they arrive (`opensesame-redaction`'s `ScrubWriter`);
sealing is what keeps the rest of what a log says from resting in the clear.

A configured sealed log that cannot be opened or keyed refuses to start the
process. It never falls back to a plaintext file or to stdout.

## Where it fits

- **Used by:** [`opensesame-cli`](../../apps/cli) (`src/log_sink.rs`: `OPENSESAME_LOG_FILE`
  for the Host, worker and daemon; `daemon start` and `daemon logs`) and
  [`opensesame-tailnet-admin`](../tailnet-admin) (its sealed audit lines
  through `seal_line` and `open_line`, and its stored Tailscale credential
  through `LogKey::seal_value`).
- **Builds on:** [`opensesame-redaction`](../redaction) (a plaintext line read
  back is scrubbed rather than trusted) and
  [`opensesame-event-seal`](../event-seal) (the `osl2.` envelope is its envelope
  under the `sealed-log.line` purpose).

## Surface

| Item | What it does |
|---|---|
| `open_sink(log, key_override)` | Load or create the key (mode 0600, published atomically, never overwritten), seal a legacy plaintext log in place, open the file owner-only and return a shareable sink. |
| `SealedLogSink::writer()` / `SealedLogWriter` | An `io::Write` that seals each complete line; plugs into `ScrubMakeWriter`. |
| `SealedLogFile` | One file: owner-only (a wider one is narrowed), rotating whole files, 8 MiB × 3 by default. |
| `read_tail(path, key, n)` | The last `n` lines, decrypted; a line that does not open reads as `UNREADABLE`. |
| `seal_existing(path, key)` | Authenticate current lines and upgrade valid legacy lines in place, atomically, scrubbing plaintext as it goes. |
| `LogKey::load_or_create` / `load` | `load` never creates, so asking for logs never mints a key nothing was sealed under. |
| `LogKey::seal_value` / `open_value` | Envelope managed values under caller-supplied trusted namespace and purpose, also bound to the local key provider namespace. |
| `key_path_for(log, override)` | `OPENSESAME_LOG_KEY_FILE`, else `<log>.key`. |

## Develop

```bash
cargo +1.88.0 test -p opensesame-sealed-log
```
