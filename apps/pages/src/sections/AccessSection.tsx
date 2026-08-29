import {
  type BoundaryValue,
  type JsonObject,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import { CeremonyLink } from "../components/CeremonyLauncher.js";
import { CeremonyShell } from "../components/CeremonyShell.js";
import {
  IconAgent,
  IconAlert,
  IconCheck,
  IconClock,
  IconCopy,
  IconLock,
  IconRefresh,
  IconSearch,
  IconSecret,
  IconShield,
} from "../components/Icons.js";
import { PagesCannotHostNote } from "../components/PagesCannotHostNote.js";
import {
  AccessError,
  type DelegationOffer,
  type RelayRequest,
  type TaskDetail,
  type TaskRun,
  approveRelayRequest,
  claimDelegation,
  denyRelayRequest,
  getTask,
  listDelegationOffers,
  listRelayRequests,
  listTasks,
  terminateTask,
} from "../lib/access.js";
import {
  type Connection,
  authorizeConnection,
  awaitConsent,
  listConnections,
  openConsentPopup,
  revokeConnection,
} from "../lib/connections.js";
import {
  HostSessionError,
  IdentityError,
  type IdentitySession,
  currentSession,
  ensureHostSession,
  hostLocalSessionEligible,
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
import { BindingEditor } from "./connections/BindingEditor.js";
import { ConnectorMark } from "./connections/ConnectorMark.js";
import { PolicyEditor } from "./connections/PolicyEditor.js";
import { type Flash, STATUS_CHIP, errorText } from "./connections/shared.js";
import "./connections.css";
import "./access.css";

type AccessTab = "resources" | "sessions" | "requests" | "policies";

const TABS: Array<{ id: AccessTab; label: string }> = [
  { id: "resources", label: "Resources" },
  { id: "sessions", label: "Sessions" },
  { id: "requests", label: "Requests" },
  { id: "policies", label: "Policies" },
];

/**
 * Access — the PAM screen (ADR 0054). Four tabs, one visible at a time:
 * see resources, watch sessions, decide requests, shape policies. Every tab
 * binds APIs the Host already serves; loads are best-effort and independent,
 * so a down Host degrades tabs individually.
 */
export function AccessSection() {
  const online = useOnline();
  const session = useIdentitySession();
  const [tab, setTab] = useState<AccessTab>("resources");

  // The inbox is loaded at section level because its count rides the Requests
  // tab as a badge; the tab itself reuses the same load and reload.
  const [requests, setRequests] = useState<RelayRequest[] | null>(null);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const inboxRun = useRef(0);

  const loadInbox = useCallback(async () => {
    const id = ++inboxRun.current;
    try {
      const pending = await listRelayRequests();
      if (inboxRun.current !== id) return;
      setRequests(pending);
      setRequestsError(null);
    } catch (error) {
      if (inboxRun.current !== id) return;
      setRequests(null);
      setRequestsError(accessErrorText(error));
    }
  }, []);

  // Poll on focus, not on a timer: an undecided approval is the one thing on
  // this screen that blocks somebody, and a background tab should not be
  // draining the inbox for nobody. A session change re-runs the load because
  // Host authentication is session-backed.
  useEffect(() => {
    if (!session && !hostLocalSessionEligible()) return;
    void loadInbox();
    const onFocus = () => void loadInbox();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadInbox, session]);

  return (
    <div className="section__inner">
      <header className="section__head">
        <h1>Access</h1>
        <p>Who can reach what, right now — and who decided.</p>
      </header>

      <PagesCannotHostNote ceremony="Requests, sessions, and live inventory" />

      <div className="access-tabs" role="tablist" aria-label="Access views">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`access-tab${tab === id ? " is-active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
            {id === "requests" && requests && requests.length > 0 ? (
              <span className="access-badge">{requests.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "resources" ? <ResourcesPanel online={online} /> : null}
      {tab === "sessions" ? (
        <SessionsPanel online={online} session={session} />
      ) : null}
      {tab === "requests" ? (
        <RequestsPanel
          online={online}
          requests={requests}
          error={requestsError}
          onChanged={() => void loadInbox()}
        />
      ) : null}
      {tab === "policies" ? <PoliciesPanel online={online} /> : null}
    </div>
  );
}

function accessErrorText<Thrown>(error: Thrown): string {
  if (error instanceof HostSessionError) return errorText(error);
  if (error instanceof AccessError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/* --------------------------------------------------------------- resources */

function isAgentSecret(item: VaultItem): item is SecretItem {
  return item.kind === "secret" && item.deletedAt === null;
}

function connectionMatches(connection: Connection, query: string): boolean {
  const haystack = [
    connection.displayName,
    connection.logicalName,
    connection.connectionRef,
    connection.providerId,
    connection.status,
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function secretMatches(item: SecretItem, query: string): boolean {
  const haystack = [
    item.name,
    item.connectionRef,
    ...item.grantees,
    ...item.ceiling.map((grant) => `${grant.action} ${grant.resource}`),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function ResourcesPanel({ online }: { online: boolean }) {
  const vault = useVault();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [flash, setFlash] = useState<Flash | null>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    try {
      const rows = await listConnections();
      if (run.current !== id) return;
      setConnections(rows);
      setLoadError(null);
    } catch (error) {
      if (run.current !== id) return;
      setConnections(null);
      setLoadError(accessErrorText(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const secrets = useMemo(() => {
    const found = vault.items.filter(isAgentSecret);
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }, [vault.items]);

  const needle = query.trim().toLowerCase();
  const shownConnections = (connections ?? []).filter(
    (connection) => !needle || connectionMatches(connection, needle),
  );
  const shownSecrets =
    vault.status === "unlocked"
      ? secrets.filter((item) => !needle || secretMatches(item, needle))
      : [];
  const nothingShown =
    connections !== null &&
    shownConnections.length === 0 &&
    shownSecrets.length === 0;

  return (
    <>
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>What can be reached</h2>
            <p>
              Host connections and the vault secrets that back agent grants —
              one inventory, searched together.
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void load()}
            disabled={!online}
            title="Reload inventory"
            aria-label="Reload inventory"
          >
            <IconRefresh />
          </button>
        </div>

        <div className="panel__body">
          <div className="field access-search">
            <label className="label" htmlFor="access-search">
              <IconSearch /> Search resources
            </label>
            <input
              id="access-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, reference, provider, status…"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          {loadError ? (
            <p className="note note--err" role="alert">
              <IconAlert /> {loadError}
            </p>
          ) : null}

          {connections === null && !loadError ? (
            <output className="note">Asking the Host…</output>
          ) : null}

          {vault.status === "unlocked" && shownSecrets.length > 0 ? (
            <p className="access-thesis">
              Secret values are never rendered here and never handed to an
              agent. An agent receives authority to act — an <em>action</em>{" "}
              against a <em>resource</em> — which the Host redeems for it.
            </p>
          ) : null}

          {shownConnections.length > 0 || shownSecrets.length > 0 ? (
            <ul className="access-resources">
              {shownConnections.map((connection) => (
                <ConnectionRow
                  key={connection.connectionId}
                  connection={connection}
                  online={online}
                  onFlash={setFlash}
                  onChanged={() => void load()}
                />
              ))}
              {shownSecrets.map((item) => (
                <SecretRow key={item.id} item={item} />
              ))}
            </ul>
          ) : null}

          {nothingShown ? (
            <div className="empty">
              <span className="empty__mark">
                <IconSearch />
              </span>
              <h3>
                {needle
                  ? "Nothing matches that search"
                  : "Nothing here can be reached yet"}
              </h3>
              <p>
                {needle ? (
                  "Try a name, a connection reference, a provider, or a status."
                ) : (
                  <>
                    Connect a service on the Host first — it shows up here with
                    its status and bindings, ready to authorize.
                  </>
                )}
              </p>
              {needle ? null : (
                <Link className="btn btn--primary" to="/connections">
                  Open Connections
                </Link>
              )}
            </div>
          ) : null}

          {vault.status === "locked" ? (
            <output className="note note--warn">
              <IconLock /> Vault is locked. Ceilings live inside the encrypted
              vault — unlock it from the Vault section to see which secrets are
              exposed to agents and how far that authority reaches.
            </output>
          ) : vault.status !== "unlocked" ? (
            <output className="note">
              <IconSecret /> No vault on this device. Create one in the Vault
              section first — agent secrets and their ceilings are stored
              encrypted alongside your logins.
            </output>
          ) : secrets.length === 0 ? (
            <p className="hint">
              No agent secrets yet.{" "}
              <Link to="/vault/new/secret">Add a secret</Link> to give an agent
              something to draw on — with a ceiling that bounds everything it
              can ever do with it.
            </p>
          ) : null}

          {flash ? (
            <output className={`note note--${flash.tone}`}>
              {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
              <p>{flash.text}</p>
            </output>
          ) : null}
        </div>
      </section>

      <RegisterAgent online={online} />
    </>
  );
}

function ConnectionRow({
  connection,
  online,
  onFlash,
  onChanged,
}: {
  connection: Connection;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const chip = STATUS_CHIP[connection.status];
  const revoked = connection.status === "revoked";

  async function authorize() {
    const popup = openConsentPopup("about:blank");
    setBusy("authorize");
    try {
      await ensureHostSession();
      const { authorizationUrl } = await authorizeConnection(
        connection.connectionId,
      );
      if (popup) popup.location.href = authorizationUrl;
      else window.location.href = authorizationUrl;
      const outcome = await awaitConsent(connection.connectionId, popup);
      if (outcome.result === "active") {
        onFlash({
          tone: "ok",
          text: `${connection.displayName} is authorized.`,
        });
      } else if (outcome.result === "failed") {
        onFlash({
          tone: "err",
          text:
            outcome.connection.statusDetail ??
            "The provider refused the authorization.",
        });
      } else {
        onFlash({ tone: "warn", text: "Authorization was not completed." });
      }
      onChanged();
    } catch (error) {
      popup?.close();
      onFlash({ tone: "err", text: accessErrorText(error) });
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    setBusy("revoke");
    try {
      const result = await revokeConnection(connection.connectionId);
      const upstream = result.providerRevocation;
      onFlash(
        upstream === "ok"
          ? { tone: "ok", text: `${connection.displayName} was revoked.` }
          : {
              tone: "warn",
              text: `${connection.displayName} was removed locally, but provider revocation was ${upstream}. Revoke it in the provider's security settings too.`,
            },
      );
      onChanged();
    } catch (error) {
      onFlash({ tone: "err", text: accessErrorText(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="access-resource">
      <div className="access-resource__main">
        <ConnectorMark
          providerId={connection.providerId}
          displayName={connection.displayName}
          size={32}
        />
        <div className="access-resource__id">
          <h3>{connection.displayName}</h3>
          <code className="access-ref">{connection.connectionRef}</code>
        </div>
        <span className={`chip ${chip.tone}`}>{chip.label}</span>
        <span className="access-resource__bindings">
          {connection.bindings.length}{" "}
          {connection.bindings.length === 1 ? "binding" : "bindings"}
        </span>
        <div className="actions">
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded((on) => !on)}
          >
            {expanded ? "Hide" : "Details"}
          </button>
          {revoked ? null : (
            <>
              <button
                type="button"
                className="btn btn--sm"
                disabled={busy !== null || !online}
                onClick={() => void authorize()}
              >
                {busy === "authorize" ? "Waiting for consent…" : "Authorize"}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--danger"
                disabled={busy !== null || !online}
                onClick={() => setConfirming(true)}
              >
                Revoke
              </button>
            </>
          )}
        </div>
      </div>

      {expanded ? (
        <div className="access-resource__detail">
          <p className="access-resource__label">Outbound boundary</p>
          {connection.egress.authorities.length > 0 ? (
            <p className="hint">
              The credential is only ever attached to{" "}
              <code>{connection.egress.scheme}</code> requests to{" "}
              {connection.egress.authorities.map((authority, index) => (
                <span key={authority}>
                  {index > 0 ? ", " : ""}
                  <code>{authority}</code>
                  {index === connection.egress.authorities.length - 1
                    ? "."
                    : ""}
                </span>
              ))}{" "}
              Anywhere else, it is not sent.
            </p>
          ) : (
            <p className="hint">No outbound provider host.</p>
          )}
          <p className="access-resource__label">Bindings</p>
          {connection.bindings.length > 0 ? (
            <ul className="access-resource__bound">
              {connection.bindings.map((binding) => (
                <li key={binding.id}>
                  <span className="chip">{binding.targetKind}</span>
                  <code>{binding.targetLabel ?? binding.targetId}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">
              Nobody yet — no project or agent can act through this connection
              until one is bound under Policies.
            </p>
          )}
        </div>
      ) : null}

      {confirming ? (
        <div className="conn-confirm">
          <p>
            Revoking cuts off every project and agent bound to{" "}
            <strong>{connection.displayName}</strong> at once, and asks the
            provider to invalidate the token.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={busy !== null}
              onClick={() => {
                setConfirming(false);
                void revoke();
              }}
            >
              Revoke it
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setConfirming(false)}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function SecretRow({ item }: { item: SecretItem }) {
  const ref = item.connectionRef.trim();
  return (
    <li className="access-secret">
      <div className="access-secret__top">
        <h3>{item.name}</h3>
        {ref ? (
          <code className="access-ref" title="Connection reference">
            {ref}
          </code>
        ) : (
          <span className="access-secret__noref">No connection reference</span>
        )}
      </div>

      <div className="access-secret__grantees">
        <span className="access-secret__label">Grantees</span>
        {item.grantees.length > 0 ? (
          <span className="access-chips">
            {item.grantees.map((grantee) => (
              <span className="chip" key={grantee}>
                {grantee}
              </span>
            ))}
          </span>
        ) : (
          <span className="access-secret__none">
            None — no agent can draw on this yet.
          </span>
        )}
      </div>

      <div className="access-ceiling">
        <span className="access-secret__label">
          <IconShield /> Capability ceiling
        </span>
        {item.ceiling.length > 0 ? (
          <ul className="access-caps">
            {item.ceiling.map((grant, i) => (
              <li
                className="access-cap"
                key={`${grant.action}:${grant.resource}:${i}`}
              >
                <span className="access-cap__action">{grant.action}</span>
                <span className="access-cap__arrow" aria-hidden="true">
                  →
                </span>
                <span className="access-cap__resource">{grant.resource}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="access-secret__none">
            Empty ceiling — an agent granted this secret could invoke nothing at
            all. Set the ceiling on the item to make it usable.
          </p>
        )}
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------- sessions */

/* --------------------------------------------------------- capability math */

type Cap = { action: string; resource: string; values: string[] };

/** Host serialises a Rust `CapabilitySet`; older shapes send a flat array. */
function readCap(raw: BoundaryValue): Cap | null {
  if (!raw || !isTypeofObject(raw)) return null;
  const obj = overlapCast(raw);
  const action = isString(obj.action) ? obj.action : "";
  if (!action) return null;
  const resource = obj.resource;
  if (isString(resource)) {
    return { action, resource, values: [resource] };
  }
  if (resource && isTypeofObject(resource)) {
    const sel = overlapCast(resource);
    if (isString(sel.value)) {
      return { action, resource: sel.value, values: [sel.value] };
    }
    if (Array.isArray(sel.values)) {
      const values = sel.values.filter((v): v is string => isString(v));
      if (values.length > 0) {
        return { action, resource: values.join(", "), values };
      }
    }
  }
  return null;
}

function readCaps(raw: BoundaryValue): Cap[] {
  let list: BoundaryValue[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && isTypeofObject(raw)) {
    const inner = overlapCast(raw).capabilities;
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

const STATUS_TONE = new Map([
  ["active", "chip--ok"],
  ["failed", "chip--err"],
  ["cancelled", "chip--err"],
  ["restricting", "chip--warn"],
  ["pending", "chip--warn"],
]);

const ROW_CHIP = {
  held: "chip--ok",
  narrowed: "chip--accent",
  outside: "chip--err",
  released: "chip--warn",
};

function statusTone(status: string): string {
  return STATUS_TONE.get(status) ?? "";
}

function rowChip(state: RowState): string {
  return ROW_CHIP[state];
}

function SessionsPanel({
  online,
  session,
}: {
  online: boolean;
  session: IdentitySession | null;
}) {
  const [tasks, setTasks] = useState<TaskRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    try {
      const rows = await listTasks();
      if (run.current !== id) return;
      setTasks(rows);
      setError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setTasks(null);
      setError(accessErrorText(caught));
    }
  }, []);

  useEffect(() => {
    if (!online) return;
    void load();
  }, [load, online]);

  async function terminate(task: TaskRun) {
    setBusyId(task.taskRunId);
    setFlash(null);
    try {
      await terminateTask(task.taskRunId, task.stateVersion);
      setFlash({ tone: "ok", text: `Task ${task.taskRunId} was terminated.` });
      void load();
    } catch (caught) {
      setFlash({ tone: "err", text: accessErrorText(caught) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Task runs</h2>
            <p>
              Who is in what, right now. The ceiling was fixed when the task
              started and cannot move — terminating ends the whole session.
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void load()}
            disabled={!online}
            title="Reload task runs"
            aria-label="Reload task runs"
          >
            <IconRefresh />
          </button>
        </div>

        <div className="panel__body">
          {!online ? (
            <output className="note note--warn">
              <IconAlert /> You are offline. A task&apos;s current capabilities
              only exist on the Host, so there is nothing local to read.
            </output>
          ) : null}

          {error ? (
            <p className="note note--err" role="alert">
              <IconAlert /> {error}
            </p>
          ) : null}

          {online && tasks === null && !error ? (
            <output className="note">Asking the Host…</output>
          ) : null}

          {tasks && tasks.length > 0 ? (
            <ul className="access-runs">
              {tasks.map((task) => (
                <TaskRow
                  key={task.taskRunId}
                  task={task}
                  online={online}
                  busy={busyId === task.taskRunId}
                  onTerminate={() => void terminate(task)}
                />
              ))}
            </ul>
          ) : null}

          {tasks && tasks.length === 0 ? (
            <div className="empty">
              <span className="empty__mark">
                <IconAgent />
              </span>
              <h3>No live task runs</h3>
              <p>
                A task run appears when an agent starts work under a ceiling you
                set. Nothing is holding task authority right now.
              </p>
            </div>
          ) : null}

          {flash ? (
            <output className={`note note--${flash.tone}`}>
              {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
              <p>{flash.text}</p>
            </output>
          ) : null}
        </div>
      </section>

      {session ? (
        <AgentActivity online={online} sessionKey={session.principalId} />
      ) : (
        <ConnectPrincipal online={online} />
      )}
    </>
  );
}

function TaskRow({
  task,
  online,
  busy,
  onTerminate,
}: {
  task: TaskRun;
  online: boolean;
  busy: boolean;
  onTerminate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (detail) return;
    setLoading(true);
    try {
      setDetail(await getTask(task.taskRunId));
      setError(null);
    } catch (caught) {
      setError(accessErrorText(caught));
    } finally {
      setLoading(false);
    }
  }

  return (
    <li className="access-run">
      <div className="access-run__main">
        <code className="access-run__id">{task.taskRunId}</code>
        <span className={`chip ${statusTone(task.status)}`}>{task.status}</span>
        <span className="access-run__version">v{task.stateVersion}</span>
        <div className="actions">
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            aria-expanded={open}
            onClick={() => void toggle()}
          >
            {open ? "Hide" : "Inspect"}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={busy || !online || task.status === "cancelled"}
            onClick={onTerminate}
          >
            {busy ? "Terminating…" : "Terminate"}
          </button>
        </div>
      </div>

      {open ? (
        <div className="access-run__detail">
          {loading ? <output className="note">Asking the Host…</output> : null}
          {error ? (
            <p className="note note--err" role="alert">
              <IconAlert /> {error}
            </p>
          ) : null}
          {detail ? <TaskCompare detail={detail} /> : null}
        </div>
      ) : null}
    </li>
  );
}

function TaskCompare({ detail }: { detail: TaskDetail }) {
  const rows = compareCeiling(
    readCaps(detail.capabilityCeiling),
    readCaps(detail.currentCapabilities),
  );

  return (
    <div className="access-task">
      <dl className="kv">
        <div>
          <dt>Task run</dt>
          <dd>
            <code>{detail.taskRunId}</code>
          </dd>
        </div>
        <div>
          <dt>State version</dt>
          <dd>{detail.stateVersion}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`chip ${statusTone(detail.status)}`}>
              {detail.status}
            </span>
          </dd>
        </div>
      </dl>

      {rows.length > 0 ? (
        <div className="scroll-x">
          <table className="table access-compare">
            <caption className="access-compare__caption">
              Immutable ceiling on the left, what this task actually holds on
              the right.
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
                    <span className="access-cap__action">
                      {row.state === "outside" ? "—" : row.action}
                    </span>
                  </td>
                  <td className="access-compare__res">
                    {row.state === "outside" ? "—" : row.resource}
                  </td>
                  <td>
                    <span className={`chip ${rowChip(row.state)}`}>
                      {row.state === "outside"
                        ? `${row.action} → ${row.resource}`
                        : row.detail}
                    </span>
                    {row.state === "outside" ? (
                      <span className="access-compare__warn">{row.detail}</span>
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
        Nothing in this task can widen. Broader authority means a new task with
        a new ceiling, which is a new decision by you.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- requests */

function RequestsPanel({
  online,
  requests,
  error,
  onChanged,
}: {
  online: boolean;
  requests: RelayRequest[] | null;
  error: string | null;
  onChanged: () => void;
}) {
  const [offers, setOffers] = useState<DelegationOffer[] | null>(null);
  const [offersError, setOffersError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const offersRun = useRef(0);

  const loadOffers = useCallback(async () => {
    const id = ++offersRun.current;
    try {
      const rows = await listDelegationOffers();
      if (offersRun.current !== id) return;
      setOffers(rows);
      setOffersError(null);
    } catch (caught) {
      if (offersRun.current !== id) return;
      setOffers(null);
      setOffersError(accessErrorText(caught));
    }
  }, []);

  useEffect(() => {
    if (!online) return;
    void loadOffers();
  }, [loadOffers, online]);

  async function decide(request: RelayRequest, approve: boolean) {
    setBusyId(request.id);
    setFlash(null);
    try {
      const decision = approve
        ? await approveRelayRequest(request.id, request.requestDigest)
        : await denyRelayRequest(request.id, request.requestDigest);
      // Consent binds to exact bytes — echo what was reviewed, not just "ok".
      setFlash({
        tone: "ok",
        text: `${
          decision.state === "approved" ? "Approved" : "Denied"
        } — reviewed digest ${request.requestDigest}.`,
      });
      onChanged();
    } catch (caught) {
      setFlash({ tone: "err", text: accessErrorText(caught) });
    } finally {
      setBusyId(null);
    }
  }

  const emptyInbox = requests !== null && requests.length === 0;
  const emptyOffers = offers !== null && offers.length === 0;

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>The approval inbox</h2>
          <p>
            Relayed executions parked in front of you, and delegation offers
            that can be claimed. Approving binds consent to the request digest —
            the exact bytes that will run.
          </p>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            onChanged();
            void loadOffers();
          }}
          disabled={!online}
          title="Reload inbox"
          aria-label="Reload inbox"
        >
          <IconRefresh />
        </button>
      </div>

      <div className="panel__body">
        {!online ? (
          <output className="note note--warn">
            <IconAlert /> You are offline. Requests live on the Host, so the
            inbox cannot be read or decided until you are back.
          </output>
        ) : null}

        {error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : null}

        {requests === null && !error ? (
          <output className="note">Asking the Host…</output>
        ) : null}

        {requests && requests.length > 0 ? (
          <ul className="access-requests">
            {requests.map((request) => (
              <li className="access-request" key={request.id}>
                <div className="access-request__top">
                  <h3>
                    <span className="access-cap__action">
                      {request.operation}
                    </span>
                    <span className="access-cap__arrow" aria-hidden="true">
                      {" "}
                      →{" "}
                    </span>
                    <span className="access-cap__resource">
                      {request.resource}
                    </span>
                  </h3>
                  <span className="chip chip--warn">{request.state}</span>
                </div>
                <dl className="kv">
                  <div>
                    <dt>Connection</dt>
                    <dd>
                      <code>{request.connectionId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Delegation</dt>
                    <dd>
                      <code>{request.delegationId}</code>
                    </dd>
                  </div>
                </dl>
                <pre className="access-request__params">
                  {JSON.stringify(request.parameters ?? {}, null, 2)}
                </pre>
                <p className="access-request__digest">
                  Request digest <code>{request.requestDigest}</code>
                </p>
                <div className="actions actions--end">
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    disabled={busyId !== null || !online}
                    onClick={() => void decide(request, true)}
                  >
                    {busyId === request.id ? "Deciding…" : "Approve"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={busyId !== null || !online}
                    onClick={() => void decide(request, false)}
                  >
                    Deny
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {offersError ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {offersError}
          </p>
        ) : null}

        {offers && offers.length > 0 ? (
          <>
            <p className="access-offers__label">Delegation offers</p>
            <ul className="access-requests">
              {offers.map((offer) => (
                <OfferCard
                  key={offer.id}
                  offer={offer}
                  online={online}
                  onFlash={setFlash}
                  onClaimed={() => void loadOffers()}
                />
              ))}
            </ul>
          </>
        ) : null}

        {emptyInbox && emptyOffers ? (
          <div className="empty">
            <span className="empty__mark">
              <IconCheck />
            </span>
            <h3>Nothing waiting on you</h3>
            <p>Standing privilege stays at zero.</p>
          </div>
        ) : null}

        {flash ? (
          <output className={`note note--${flash.tone}`}>
            {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
            <p>{flash.text}</p>
          </output>
        ) : null}
      </div>
    </section>
  );
}

function OfferCard({
  offer,
  online,
  onFlash,
  onClaimed,
}: {
  offer: DelegationOffer;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onClaimed: () => void;
}) {
  const [claiming, setClaiming] = useState(false);
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function claim(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const delegations = await claimDelegation({
        claimToken: token.trim(),
        userCode: code.trim(),
        // Every item id is named explicitly — accepting something unseen is
        // exactly what the manifest step exists to prevent.
        acceptedItemIds: offer.items.map((item) => item.id),
      });
      onFlash({
        tone: "ok",
        text: `Claimed — ${delegations.length} delegation${
          delegations.length === 1 ? "" : "s"
        } minted for this principal.`,
      });
      setClaiming(false);
      setToken("");
      setCode("");
      onClaimed();
    } catch (caught) {
      onFlash({ tone: "err", text: accessErrorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="access-request">
      <div className="access-request__top">
        <h3>Offer {offer.id}</h3>
        <span className="chip">{offer.state}</span>
      </div>
      <ul className="access-offer__items">
        {offer.items.map((item) => (
          <li key={item.id}>
            <strong>{item.displayName || item.connectionId}</strong>{" "}
            <code>{item.actions.join(", ") || "no actions"}</code> →{" "}
            <code>{item.resources.join(", ") || "*"}</code>{" "}
            <span className="chip">{item.executionMode}</span>
            {item.required ? (
              <span className="chip chip--warn">required</span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="hint">Expires {formatTime(offer.expiresAt)}.</p>

      {claiming ? (
        <form className="access-claim" onSubmit={claim}>
          <div className="field">
            <label className="label" htmlFor={`claim-token-${offer.id}`}>
              Claim token
            </label>
            <input
              id={`claim-token-${offer.id}`}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="osc_dlg_…"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor={`claim-code-${offer.id}`}>
              User code
            </label>
            <input
              id={`claim-code-${offer.id}`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="AAAA-BBBB"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
          </div>
          <div className="actions">
            <button
              type="submit"
              className="btn btn--sm btn--primary"
              disabled={busy || !online || !token.trim() || !code.trim()}
            >
              {busy ? "Claiming…" : "Claim it"}
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setClaiming(false)}
            >
              Cancel
            </button>
          </div>
          <p className="hint">
            Claiming accepts every item in this offer under your principal. The
            user code travels out of band — it is not in the link.
          </p>
        </form>
      ) : (
        <div className="actions actions--end">
          <button
            type="button"
            className="btn btn--sm"
            disabled={!online}
            onClick={() => setClaiming(true)}
          >
            Claim
          </button>
        </div>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------- policies */

function PoliciesPanel({ online }: { online: boolean }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    try {
      const rows = await listConnections();
      if (run.current !== id) return;
      setConnections(rows);
      setError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setConnections(null);
      setError(accessErrorText(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const live = (connections ?? []).filter(
    (connection) => connection.status !== "revoked",
  );
  const selected =
    live.find((connection) => connection.connectionId === selectedId) ??
    live[0] ??
    null;

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Who may do what</h2>
          <p>
            The Host&apos;s policy for one connection at a time: how far it may
            be delegated, and which identities, projects, and agents are bound
            to it.
          </p>
        </div>
      </div>

      <div className="panel__body">
        {error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : null}

        {connections === null && !error ? (
          <output className="note">Asking the Host…</output>
        ) : null}

        {connections !== null && live.length === 0 ? (
          <div className="empty">
            <span className="empty__mark">
              <IconShield />
            </span>
            <h3>No connections to shape</h3>
            <p>
              Policy hangs off a connection. Connect a service first, then its
              delegation and bindings are edited here.
            </p>
            <Link className="btn btn--primary" to="/connections">
              Open Connections
            </Link>
          </div>
        ) : null}

        {selected ? (
          <>
            <div className="field">
              <label className="label" htmlFor="access-policy-connection">
                Connection
              </label>
              <select
                id="access-policy-connection"
                value={selected.connectionId}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {live.map((connection) => (
                  <option
                    key={connection.connectionId}
                    value={connection.connectionId}
                  >
                    {connection.displayName}
                  </option>
                ))}
              </select>
            </div>

            <PolicyEditor
              connection={selected}
              online={online}
              onFlash={setFlash}
              onChanged={() => void load()}
            />
            <BindingEditor
              connection={selected}
              online={online}
              onFlash={setFlash}
              onChanged={() => void load()}
            />
          </>
        ) : null}

        {flash ? (
          <output className={`note note--${flash.tone}`}>
            {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
            <p>{flash.text}</p>
          </output>
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------- agent registration */

type ClaimResult = {
  agentId: string;
  instanceId: string;
  state: string;
  claimId: string;
  /** Bearer for this one claim. The Claim ownership tab accepts nothing else. */
  claimToken: string;
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
    // Registration binds the instance to whichever principal authenticates the
    // request, so the one in force now is the one to hold it to. Without a bearer
    // here a leftover cookie would answer for it, and the claim below would name
    // an owner this tab cannot see.
    const active = currentSession();
    if (!active) {
      setError(
        "Registering binds the agent to a principal, and this tab does not have one. Connect on the Authority tab first.",
      );
      return;
    }
    setBusy(true);
    try {
      const body = await identityJson<ClaimResult>("/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name, publicKeyJkt: jkt }),
      });
      if (currentSession()?.accessToken !== active.accessToken) {
        // It landed under the principal that was connected when it went out.
        // Showing its claim here would invite the wrong one to accept it.
        setError(
          "The agent was registered under the principal that was connected when this went out, and the session changed since. Its claim belongs to that principal — register again for the one connected now.",
        );
        return;
      }
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
          <h2>Register a service account</h2>
          <p>
            Registration mints an agent instance bound to a public key
            thumbprint. It grants nothing on its own.
          </p>
        </div>
      </div>

      <div className="panel__body">
        <form onSubmit={register}>
          <div className="field">
            <label className="label" htmlFor="access-display-name">
              Display name
            </label>
            <input
              id="access-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Nightly release bot"
              maxLength={128}
              disabled={busy}
            />
          </div>

          <div className="access-key">
            <div className="access-key__row">
              <span className="access-secret__label">
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
              <div className="access-key__value">
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

        {/* What was minted, as the same found-card every ceremony ends on:
            the agent, its facts, and the two ways a human completes the
            claim. */}
        {claim ? (
          <CeremonyShell
            ok={false}
            top={claim.state}
            name={`Registered as ${claim.agentId}`}
            facts={[
              { key: "Instance", value: claim.instanceId },
              { key: "Expires", value: formatTime(claim.expiresAt) },
            ]}
            primary={{
              label:
                copied === "token" ? "Claim token copied" : "Copy claim token",
              onClick: () => copy(claim.claimToken, "token"),
            }}
            secondary={
              verificationUrl
                ? {
                    label: "Open verification page",
                    onClick: () =>
                      window.open(
                        verificationUrl,
                        "_blank",
                        "noopener,noreferrer",
                      ),
                  }
                : undefined
            }
          >
            <p className="hint">
              The agent stays provisional until a human completes the claim.
              Either read the user code at the verification page, or take the
              claim token to <strong>Authority → Claim ownership</strong>, which
              accepts the token and nothing else.
            </p>
            <div className="access-claim__code">
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
            <p className="hint">
              The claim token is a single-use bearer credential, so it is not
              shown here — copying it is the only way it leaves this page, and
              it is never written to disk.
            </p>
            {!verificationUrl ? (
              <p className="note note--err" role="alert">
                <span>
                  The Identity API returned a verification address this app will
                  not open: <code>{claim.verificationUri}</code>
                </span>
              </p>
            ) : null}
          </CeremonyShell>
        ) : null}
      </div>
    </section>
  );
}

function registerErrorFor<Thrown>(err: Thrown): string {
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
  metadata?: JsonObject;
};

function isAgentEvent(event: AuditEvent): boolean {
  if (event.eventType.startsWith("agent.")) return true;
  if (event.actorType === "agent") return true;
  const instance = event.metadata?.agentInstanceId;
  return isString(instance) && instance.length > 0;
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
  /** A trail read for one principal must never land under another. */
  const run = useRef(0);
  const shownFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    const id = ++run.current;
    const superseded = () => run.current !== id;
    setBusy(true);
    setError(null);
    try {
      const body = await identityJson<{ events: AuditEvent[] }>(
        "/v1/audit/events?limit=50",
      );
      if (superseded()) return;
      setEvents(body.events.filter(isAgentEvent));
    } catch (err) {
      if (superseded()) return;
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
      if (!superseded()) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (shownFor.current !== sessionKey) {
      // The trail on screen belongs to another principal. Drop it rather than
      // let it read as this one's while the new one loads.
      shownFor.current = sessionKey;
      run.current += 1;
      setEvents(null);
      setError(null);
    }
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
          <ul className="access-trail">
            {events.map((event) => (
              <li key={event.id}>
                <span className="access-trail__when">
                  <IconClock /> {formatTime(event.occurredAt)}
                </span>
                <span className="access-trail__type">{event.eventType}</span>
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

const OUTCOME_CHIP = new Map([
  ["succeeded", "chip--ok"],
  ["denied", "chip--warn"],
  ["failed", "chip--err"],
]);

function outcomeChip(outcome: string): string {
  return OUTCOME_CHIP.get(outcome) ?? "";
}

/* ------------------------------------------------------------ no principal */

function ConnectPrincipal({ online }: { online: boolean }) {
  const { connecting, error, connect } = useConnect();

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>The receipt trail needs a principal</h2>
          <p>
            Reading back what agents did is scoped to you — connect to see it.
          </p>
        </div>
      </div>
      <div className="panel__body">
        {/* The same connect-a-principal ceremony shape used everywhere
            else, instead of a bespoke empty state. */}
        <CeremonyShell
          ok={false}
          top="Not connected"
          name="No principal on this tab"
          facts={[{ key: "Identity API", value: identityBase() }]}
          primary={{
            label: connecting ? "Connecting…" : "Connect to Identity",
            onClick: () => void connect(),
            busy: connecting,
            disabled: !online,
          }}
        >
          <p className="hint">
            Connecting creates a provisional principal on the Identity service
            when you need the full Identity plane. On a local Host with
            OPENSESAME_DEV_BOOTSTRAP, connector OAuth can use Host-local
            authority without this step. That is enough to register an agent and
            read your own audit trail; it is not enough for anything that
            demands a verified human, and the API will say so plainly when you
            hit that line.
          </p>
        </CeremonyShell>
        {!online ? (
          <output className="note note--warn">
            <IconAlert /> Offline — connecting needs the Identity service to
            answer.
          </output>
        ) : null}
        {error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {messageOf(error)} Check that Identity is running, or
            repair it in place:{" "}
            <CeremonyLink id="identity">
              Open the Identity ceremony
            </CeremonyLink>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- helpers */

function messageOf(value: BoundaryValue): string {
  if (isString(value) && value.trim()) return value;
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
