# Controlled agent-canary receiver

A canary is a detection-only MCP endpoint or connection reference. It carries no
vault key, provider credential, agent capability, or destructive action. Its
bearer authorizes only a bounded local detection record. Use it only in a place
you control and after explicit enrollment consent.

The local vault's fresh-owner security operation creates the pairing document.
It includes a public P-256 key, service ID, exact browser origin, receiver
endpoint and loopback bind port. Keep the matching private key in the vault;
never copy it into the receiver. Receiver enrollment, inspection, removal and
configuration export each require a new signed, one-use, 60-second command
challenge. Configured vault factors apply before the owner signs that command.

Save the exported public pairing as a regular file readable only by its owner
(mode `0600`) and create a private state directory (mode `0700`). Start the
installed Node client:

```sh
opensesame-id security canary serve --pairing ./pairing.json --state ./receiver-state
```

The service binds only `127.0.0.1` at the pairing's configured port. Plain HTTP is
accepted only for that exact loopback endpoint. A remote HTTPS endpoint requires
an explicitly configured TLS proxy to this listener; the endpoint and browser
origin remain pinned. No remote server, tunnel or notification provider is
created automatically.

The same owner operations are available at the terminal. Supply your explicitly
chosen receiver values; the command prompts privately for the current primary
and configured second step. `--primary` and `--factor` select methods, never
carry the secret or verification code. Pairing export with `--out` creates a
new owner-private file:

```sh
opensesame-id vault canary pairing --receiver "$RECEIVER_URL" --service-id "$SERVICE_ID" --origin "$BROWSER_ORIGIN" --port "$BIND_PORT" --out ./pairing.json
```

Use `vault canary inspect`, `enroll`, `remove <id>` and `export <id>` with the
same receiver flags. Enrollment additionally requires `--label`,
`--artifact-kind mcp-config` (or `connection-reference`), `--owner-consent`, and
optionally `--retention-days` from 1 to 90. A configuration export is also
written to a new private file with `--out`; do not paste its artifact bearer
into an agent conversation.

The state directory holds an independent random receiver key and authenticated
AES-GCM records. Writes replace the state atomically after syncing the new file.
A process lock refuses a second writer. SIGINT/SIGTERM closes the listener and
releases the lock. Following a hard kill, first verify that no receiver is using
the directory before removing its leftover `receiver.lock`; retain the key and
sealed state together. Tampered, foreign or nonprivate state fails closed.

After pairing, enroll a canary through a fresh owner operation and export its
configuration. The MCP form contains an endpoint and a detection-only bearer.
The connection-reference form contains the same endpoint and token plus its
reference ID. The receiver implements MCP initialize, tool listing and a
`canary_status` tool. It records connection and tool interactions; it does not
proxy any operation to a production connector.

Enrollments last between one and 90 days. The receiver retains at most 128
records and 1,024 recent events. Removing or expiring an enrollment immediately
refuses its artifact bearer. The originating vault retains the encrypted export
material; a different owner context cannot export its configuration. A local
clock is used for expiry, so this is not protection against host-clock rollback.

The receiver requires filesystem privacy semantics that Node can verify. Clients
on other platforms can use an explicitly paired HTTPS receiver; do not weaken
private-file checks to make an unsupported filesystem appear protected.
