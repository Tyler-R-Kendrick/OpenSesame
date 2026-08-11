import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import {
  IconAgent,
  IconAlert,
  IconCheck,
  IconClock,
  IconCopy,
  IconExternal,
  IconLock,
  IconRefresh,
  IconSecret,
  IconShield,
} from "../components/Icons.js";
import {
  IdentityError,
  currentSession,
  hostBase,
  hostFetch,
  identityBase,
  identityJson,
  useConnect,
  useIdentitySession,
} from "../lib/identity.js";
import { useOnline } from "../lib/use-online.js";
import { useVault } from "../lib/vault/hooks.js";
import {
  type SecretItem,
  type VaultItem,
  browsableUrl,
} from "../lib/vault/model.js";
import "./agents.css";

export function AgentsSection() {
  const online = useOnline();
  const session = useIdentitySession();

  return (
    <div className="section__inner">
      <header className="section__head">
        <h1>Agents</h1>
        <p>
          An agent never reads a secret out of this vault. It is handed a scoped
          grant, it invokes through the Host, and the Host hands back a receipt.
        </p>
      </header>

      <SecretsAndCeilings />
      <TaskInspector online={online} />

      {session ? (
        <div className="agents-split">
          <RegisterAgent online={online} />
          <AgentActivity online={online} sessionKey={session.principalId} />
        </div>
      ) : (
        <ConnectPrincipal online={online} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- secrets */

function isAgentSecret(item: VaultItem): item is SecretItem {
  return item.kind === "secret" && item.deletedAt === null;
}

function SecretsAndCeilings() {
  const vault = useVault();

  const secrets = useMemo(() => {
    const found = vault.items.filter(isAgentSecret);
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }, [vault.items]);

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Secrets held for agents</h2>
          <p>
            Each of these can back an agent grant. The ceiling is the boundary:
            a task starts at or below it and can only shrink from there.
          </p>
        </div>
        {vault.status === "unlocked" && secrets.length > 0 ? (
          <span className="chip chip--accent">
            {secrets.length} {secrets.length === 1 ? "secret" : "secrets"}
          </span>
        ) : null}
      </div>

      <div className="panel__body">
        {vault.status === "unlocked" ? (
          secrets.length > 0 ? (
            <>
              <p className="agents-thesis">
                These values are never rendered here and never handed to an
                agent. An agent receives authority to act — an <em>action</em>{" "}
                against a <em>resource</em> — which the Host redeems for it.
              </p>
              <ul className="agents-secrets">
                {secrets.map((item) => (
                  <SecretRow key={item.id} item={item} />
                ))}
              </ul>
            </>
          ) : (
            <div className="empty">
              <span className="empty__mark">
                <IconSecret />
              </span>
              <h3>No agent secrets yet</h3>
              <p>
                An agent secret is a credential you never intend to read
                yourself — an API token, a signing key, a database password. You
                store the value here, name the connection it belongs to, list
                which agents may draw on it, and set a ceiling of{" "}
                <em>action → resource</em> pairs that bounds everything they can
                ever do with it.
              </p>
              <Link className="btn btn--primary" to="/vault/new/secret">
                Add a secret
              </Link>
            </div>
          )
        ) : vault.status === "locked" ? (
          <div className="empty">
            <span className="empty__mark">
              <IconLock />
            </span>
            <h3>Vault is locked</h3>
            <p>
              Ceilings live inside the encrypted vault. Unlock it from the Vault
              section to see which secrets are exposed to agents and how far
              that authority reaches.
            </p>
          </div>
        ) : (
          <div className="empty">
            <span className="empty__mark">
              <IconSecret />
            </span>
            <h3>No vault on this device</h3>
            <p>
              Create a vault in the Vault section first. Agent secrets and their
              ceilings are stored encrypted alongside your logins — there is no
              separate agent store.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function SecretRow({ item }: { item: SecretItem }) {
  const ref = item.connectionRef.trim();
  return (
    <li className="agents-secret">
      <div className="agents-secret__top">
        <h3>{item.name}</h3>
        {ref ? (
          <code className="agents-ref" title="Connection reference">
            {ref}
          </code>
        ) : (
          <span className="agents-secret__noref">No connection reference</span>
        )}
      </div>

      <div className="agents-secret__grantees">
        <span className="agents-secret__label">Grantees</span>
        {item.grantees.length > 0 ? (
          <span className="agents-chips">
            {item.grantees.map((g) => (
              <span className="chip" key={g}>
                {g}
              </span>
            ))}
          </span>
        ) : (
          <span className="agents-secret__none">
            None — no agent can draw on this yet.
          </span>
        )}
      </div>

      <div className="agents-ceiling">
        <span className="agents-secret__label">
          <IconShield /> Capability ceiling
        </span>
        {item.ceiling.length > 0 ? (
          <ul className="agents-caps">
            {item.ceiling.map((grant, i) => (
              <li
                className="agents-cap"
                key={`${grant.action}:${grant.resource}:${i}`}
              >
                <span className="agents-cap__action">{grant.action}</span>
                <span className="agents-cap__arrow" aria-hidden="true">
                  →
                </span>
                <span className="agents-cap__resource">{grant.resource}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="agents-secret__none">
            Empty ceiling — an agent granted this secret could invoke nothing at
            all. Set the ceiling on the item to make it usable.
          </p>
        )}
      </div>
    </li>
  );
}

/* --------------------------------------------------------- capability math */

type Cap = { action: string; resource: string; values: string[] };

/** Host serialises a Rust `CapabilitySet`; older shapes send a flat array. */
function readCap(raw: unknown): Cap | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const action = typeof obj.action === "string" ? obj.action : "";
  if (!action) return null;
  const resource = obj.resource;
  if (typeof resource === "string") {
    return { action, resource, values: [resource] };
  }
  if (resource && typeof resource === "object") {
    const sel = resource as Record<string, unknown>;
    if (typeof sel.value === "string") {
      return { action, resource: sel.value, values: [sel.value] };
    }
    if (Array.isArray(sel.values)) {
      const values = sel.values.filter(
        (v): v is string => typeof v === "string",
      );
      if (values.length > 0) {
        return { action, resource: values.join(", "), values };
      }
    }
  }
  return null;
}

function readCaps(raw: unknown): Cap[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object") {
    const inner = (raw as { capabilities?: unknown }).capabilities;
    if (Array.isArray(inner)) list = inner;
  }
  return list.map(readCap).filter((c): c is Cap => c !== null);
}

type RowState = "held" | "narrowed" | "released" | "outside";
type CompareRow = {
  key: string;
  action: string;
  resource: string;
  state: RowState;
  detail: string;
};

function compareCeiling(ceiling: Cap[], current: Cap[]): CompareRow[] {
  const rows: CompareRow[] = ceiling.map((cap, i) => {
    const at = { key: `ceil-${i}`, action: cap.action, resource: cap.resource };
    const match = current.find(
      (held) =>
        held.action === cap.action &&
        held.values.some((v) => cap.values.includes(v)),
    );
    if (!match) {
      return {
        ...at,
        state: "released",
        detail: "Released — not held in this task",
      };
    }
    const kept = match.values.filter((v) => cap.values.includes(v));
    if (kept.length === cap.values.length) {
      return { ...at, state: "held", detail: "Held in full" };
    }
    return {
      ...at,
      state: "narrowed",
      detail: `Narrowed to ${kept.join(", ")}`,
    };
  });

  current.forEach((held, i) => {
    const covered = ceiling.some(
      (cap) =>
        cap.action === held.action &&
        held.values.every((v) => cap.values.includes(v)),
    );
    if (!covered) {
      rows.push({
        key: `extra-${i}`,
        action: held.action,
        resource: held.resource,
        state: "outside",
        detail: "Held but outside the ceiling — report this Host",
      });
    }
  });

  return rows;
}

/* --------------------------------------------------------- task inspection */

type TaskView = {
  taskRunId: string;
  stateVersion: number;
  status: string;
  ceiling: Cap[];
  current: Cap[];
};

function TaskInspector({ online }: { online: boolean }) {
  const [taskId, setTaskId] = useState("");
  const [task, setTask] = useState<TaskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useIdentitySession();

  const base = hostBase();
  const blocked = !online || !session;

  async function inspect(event: FormEvent) {
    event.preventDefault();
    const id = taskId.trim();
    setError(null);
    if (!id) {
      setError("Enter the task run id you want to inspect.");
      return;
    }
    if (!currentSession()) {
      setError(
        "Connect to Identity before asking the Host to describe a task.",
      );
      return;
    }
    setBusy(true);
    setTask(null);
    try {
      const res = await hostFetch(`/api/v1/tasks/${encodeURIComponent(id)}`);
      if (!res.ok) {
        setError(taskErrorFor(res.status, base));
        return;
      }
      const body = (await res.json()) as Record<string, unknown>;
      setTask({
        taskRunId: String(body.task_run_id ?? id),
        stateVersion: Number(body.state_version ?? 0),
        status: String(body.status ?? "unknown"),
        ceiling: readCaps(body.capability_ceiling),
        current: readCaps(body.current_capabilities),
      });
    } catch (caught) {
      setError(
        caught instanceof TypeError
          ? `Host API unreachable at ${base}. Start the Host, or point at a running one under Settings.`
          : caught instanceof Error
            ? caught.message
            : `Host API unreachable at ${base}. Start the Host, or point at a running one under Settings.`,
      );
    } finally {
      setBusy(false);
    }
  }

  const rows = task ? compareCeiling(task.ceiling, task.current) : [];

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Inspect a live task</h2>
          <p>
            The ceiling was fixed when the task started and cannot move. What
            the task holds right now sits inside it — or has already been given
            up.
          </p>
        </div>
      </div>

      <div className="panel__body">
        <form className="agents-lookup" onSubmit={inspect}>
          <div className="field">
            <label className="label" htmlFor="agents-task-id">
              Task run id
            </label>
            <input
              id="agents-task-id"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
          </div>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || blocked}
            aria-busy={busy}
          >
            {busy ? "Asking the Host…" : "Inspect"}
          </button>
        </form>

        {!online ? (
          <output className="note note--warn">
            <IconAlert /> You are offline. A task&apos;s current capabilities
            only exist on the Host, so there is nothing local to read — this
            lookup stays disabled until the browser is back online.
          </output>
        ) : !session ? (
          <output className="note note--warn">
            <IconAlert /> Connect to Identity first. The Host will issue a
            short-lived session scoped to your tasks.
          </output>
        ) : (
          <p className="hint">
            Queried against <code>{base}</code> as your connected principal.
          </p>
        )}

        {error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : null}

        {task ? (
          <div className="agents-task">
            <dl className="kv">
              <div>
                <dt>Task run</dt>
                <dd>
                  <code>{task.taskRunId}</code>
                </dd>
              </div>
              <div>
                <dt>State version</dt>
                <dd>{task.stateVersion}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <span className={`chip ${statusChip(task.status)}`}>
                    {task.status}
                  </span>
                </dd>
              </div>
            </dl>

            {rows.length > 0 ? (
              <div className="scroll-x">
                <table className="table agents-compare">
                  <caption className="agents-compare__caption">
                    Immutable ceiling on the left, what this task actually holds
                    on the right.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Ceiling — action</th>
                      <th scope="col">Ceiling — resource</th>
                      <th scope="col">In this task</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key}>
                        <td>
                          <span className="agents-cap__action">
                            {row.state === "outside" ? "—" : row.action}
                          </span>
                        </td>
                        <td className="agents-compare__res">
                          {row.state === "outside" ? "—" : row.resource}
                        </td>
                        <td>
                          <span className={`chip ${rowChip(row.state)}`}>
                            {row.state === "outside"
                              ? `${row.action} → ${row.resource}`
                              : row.detail}
                          </span>
                          {row.state === "outside" ? (
                            <span className="agents-compare__warn">
                              {row.detail}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <output className="note">
                This task carries no capabilities at all — neither a ceiling nor
                anything held. It can invoke nothing.
              </output>
            )}

            <p className="hint">
              Nothing in this task can widen. Broader authority means a new task
              with a new ceiling, which is a new decision by you.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function taskErrorFor(status: number, base: string): string {
  if (status === 404) {
    return "No task with that id on this Host.";
  }
  if (status === 400) {
    return "The Host rejected that id as malformed. A task run id is a UUID — copy it from the Host or from the receipt that referenced it.";
  }
  if (status === 401 || status === 403) {
    return "The Host refused this user session. Reconnect to Identity and try again.";
  }
  if (status === 503) {
    return `The Host at ${base} could not authorize this user session.`;
  }
  return `The Host answered ${status} and did not describe the task. Check the Host logs at ${base}.`;
}

const STATUS_CHIP: Record<string, string> = {
  active: "chip--ok",
  failed: "chip--err",
  cancelled: "chip--err",
  restricting: "chip--warn",
  pending: "chip--warn",
};

const ROW_CHIP: Record<RowState, string> = {
  held: "chip--ok",
  narrowed: "chip--accent",
  outside: "chip--err",
  released: "chip--warn",
};

function statusChip(status: string): string {
  return STATUS_CHIP[status] ?? "";
}

function rowChip(state: RowState): string {
  return ROW_CHIP[state];
}

/* ------------------------------------------------------- agent registration */

type ClaimResult = {
  agentId: string;
  instanceId: string;
  state: string;
  claimId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
};

function base64url(bytes: ArrayBuffer): string {
  const chars = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(chars).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7638: SHA-256 over the canonical JWK with members in lexicographic order. */
async function thumbprintOf(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return base64url(digest);
}

function RegisterAgent({ online }: { online: boolean }) {
  const [displayName, setDisplayName] = useState("");
  const [jkt, setJkt] = useState<string | null>(null);
  const [keying, setKeying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimResult | null>(null);
  const { copy, copied } = useCopy();
  // The Identity API is configurable, so its URI is not trusted as a link target.
  const verificationUrl = claim ? browsableUrl(claim.verificationUri) : null;

  async function generateKey() {
    setError(null);
    setKeying(true);
    try {
      // `false` marks the private key non-extractable; WebCrypto always leaves
      // the public key of an ECDSA pair exportable.
      const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      setJkt(await thumbprintOf(jwk));
      setClaim(null);
    } catch {
      setError(
        "This browser would not generate an ECDSA P-256 key. WebCrypto needs a secure context — open the app over HTTPS or on localhost.",
      );
    } finally {
      setKeying(false);
    }
  }

  async function register(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const name = displayName.trim();
    if (!name) {
      setError("Give the agent a display name so you can recognise it later.");
      return;
    }
    if (!jkt) {
      setError("Generate a keypair first — the registration is bound to it.");
      return;
    }
    setBusy(true);
    try {
      const body = await identityJson<ClaimResult>("/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name, publicKeyJkt: jkt }),
      });
      setClaim(body);
    } catch (err) {
      setError(registerErrorFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Register an agent</h2>
          <p>
            Registration mints an instance bound to a public key thumbprint. It
            grants nothing on its own.
          </p>
        </div>
      </div>

      <div className="panel__body">
        <form onSubmit={register}>
          <div className="field">
            <label className="label" htmlFor="agents-display-name">
              Display name
            </label>
            <input
              id="agents-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Nightly release bot"
              maxLength={128}
              disabled={busy}
            />
          </div>

          <div className="agents-key">
            <div className="agents-key__row">
              <span className="agents-secret__label">
                Public key thumbprint (RFC 7638)
              </span>
              <button
                type="button"
                className="btn btn--sm"
                onClick={generateKey}
                disabled={keying || busy}
                aria-busy={keying}
              >
                {keying
                  ? "Generating…"
                  : jkt
                    ? "Regenerate"
                    : "Generate keypair"}
              </button>
            </div>
            {jkt ? (
              <div className="agents-key__value">
                <code>{jkt}</code>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => copy(jkt, "jkt")}
                  title="Copy thumbprint"
                  aria-label="Copy thumbprint"
                >
                  {copied === "jkt" ? <IconCheck /> : <IconCopy />}
                </button>
              </div>
            ) : null}
            <p className="hint">
              WebCrypto generates an ECDSA P-256 keypair here. The private key
              is non-extractable and is dropped as soon as the thumbprint is
              computed — it is never sent, never written to disk, and cannot be
              recovered. Only the thumbprint leaves this page, so an agent that
              needs to keep proving who it is must register with a key its own
              runtime holds.
            </p>
          </div>

          <div className="actions actions--end">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !online || !jkt}
              aria-busy={busy}
            >
              {busy ? "Registering…" : "Register agent"}
            </button>
          </div>
        </form>

        {!online ? (
          <output className="note note--warn">
            <IconAlert /> Offline. Registration writes to the Identity service,
            so it has to wait until you are back online.
          </output>
        ) : null}

        {error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : null}

        {claim ? (
          <div className="agents-claim">
            <div className="agents-claim__top">
              <span className="chip chip--warn">{claim.state}</span>
              <span>
                Registered as <code>{claim.agentId}</code>
              </span>
            </div>
            <p>
              The agent stays provisional until a human completes the claim.
              Read this code at the verification page to finish it.
            </p>
            <div className="agents-claim__code">
              <code>{claim.userCode}</code>
              <button
                type="button"
                className="icon-btn"
                onClick={() => copy(claim.userCode, "code")}
                title="Copy user code"
                aria-label="Copy user code"
              >
                {copied === "code" ? <IconCheck /> : <IconCopy />}
              </button>
            </div>
            {verificationUrl ? (
              <a
                className="btn"
                href={verificationUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                <IconExternal /> Open verification page
              </a>
            ) : (
              <p className="note note--err" role="alert">
                <span>
                  The Identity API returned a verification address this app will
                  not open: <code>{claim.verificationUri}</code>
                </span>
              </p>
            )}
            <p className="hint">
              Instance <code>{claim.instanceId}</code> · expires{" "}
              {formatTime(claim.expiresAt)}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function registerErrorFor(err: unknown): string {
  if (err instanceof IdentityError) {
    if (err.status === 401) {
      return "Your principal session was rejected. Reconnect and try again.";
    }
    if (err.status === 403) {
      return "Policy denied this registration. Your principal is not allowed to register another agent — raise your assurance or retire an existing one.";
    }
    if (err.status === 400) {
      return "Identity rejected the request as invalid. The display name must be 1–128 characters.";
    }
    return `Identity answered ${err.status} and did not register the agent. ${err.message}`;
  }
  return `Identity API unreachable at ${identityBase()}. Start it, or point at a running one under Settings.`;
}

/* ------------------------------------------------------------- audit trail */

type AuditEvent = {
  id: string;
  occurredAt: string;
  eventType: string;
  outcome: string;
  actorType?: string;
  metadata?: Record<string, unknown>;
};

function isAgentEvent(event: AuditEvent): boolean {
  if (event.eventType.startsWith("agent.")) return true;
  if (event.actorType === "agent") return true;
  const instance = event.metadata?.agentInstanceId;
  return typeof instance === "string" && instance.length > 0;
}

function AgentActivity({
  online,
  sessionKey,
}: {
  online: boolean;
  sessionKey: string;
}) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const body = await identityJson<{ events: AuditEvent[] }>(
        "/v1/audit/events?limit=50",
      );
      setEvents(body.events.filter(isAgentEvent));
    } catch (err) {
      setEvents(null);
      if (err instanceof IdentityError) {
        setError(
          err.status === 401
            ? "Your session was rejected, so the trail could not be read. Reconnect and retry."
            : `Identity answered ${err.status} for the audit trail. Check the Identity logs.`,
        );
      } else {
        setError(
          `Identity API unreachable at ${identityBase()}, so the receipt trail cannot be read. Start it, or correct the address under Settings.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionKey is the trigger — a new principal has a different trail and must not show the previous one
  useEffect(() => {
    if (!online) return;
    void load();
  }, [load, online, sessionKey]);

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Recent agent activity</h2>
          <p>The receipt trail on your principal — 50 most recent events.</p>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void load()}
          disabled={busy || !online}
          title="Reload trail"
          aria-label="Reload trail"
        >
          <IconRefresh />
        </button>
      </div>

      <div className="panel__body panel__body--tight">
        {!online ? (
          <output className="note note--warn">
            <IconAlert /> Offline. The trail is held by Identity, not by this
            page, so there is nothing cached to show.
          </output>
        ) : error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : busy && events === null ? (
          <output className="note">Reading the trail…</output>
        ) : events && events.length > 0 ? (
          <ul className="agents-trail">
            {events.map((event) => (
              <li key={event.id}>
                <span className="agents-trail__when">
                  <IconClock /> {formatTime(event.occurredAt)}
                </span>
                <span className="agents-trail__type">{event.eventType}</span>
                <span className={`chip ${outcomeChip(event.outcome)}`}>
                  {event.outcome}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty">
            <span className="empty__mark">
              <IconAgent />
            </span>
            <h3>No agent events yet</h3>
            <p>
              Nothing on this principal has touched an agent. Registering one
              writes the first receipt here.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

const OUTCOME_CHIP: Record<string, string> = {
  succeeded: "chip--ok",
  denied: "chip--warn",
  failed: "chip--err",
};

function outcomeChip(outcome: string): string {
  return OUTCOME_CHIP[outcome] ?? "";
}

/* ------------------------------------------------------------ no principal */

function ConnectPrincipal({ online }: { online: boolean }) {
  const { connecting, error, connect } = useConnect();

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Registration and receipts need a principal</h2>
          <p>
            Both halves of the ceremony — minting an agent identity and reading
            back its receipts — are scoped to you.
          </p>
        </div>
      </div>
      <div className="panel__body">
        <div className="empty">
          <span className="empty__mark">
            <IconAgent />
          </span>
          <h3>Not connected to Identity</h3>
          <p>
            Connecting creates a provisional principal on the Identity service.
            That is enough to register an agent and read your own audit trail;
            it is not enough for anything that demands a verified human, and the
            API will say so plainly when you hit that line.
          </p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void connect()}
            disabled={connecting || !online}
            aria-busy={connecting}
          >
            {connecting ? "Connecting…" : "Connect to Identity"}
          </button>
        </div>
        {!online ? (
          <output className="note note--warn">
            <IconAlert /> Offline — connecting needs the Identity service to
            answer.
          </output>
        ) : null}
        {error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {messageOf(error)} Check that Identity is running and
            that its address under Settings is correct.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- helpers */

function messageOf(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value instanceof Error && value.message) return value.message;
  return "Could not connect.";
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }, []);

  return { copy, copied };
}
