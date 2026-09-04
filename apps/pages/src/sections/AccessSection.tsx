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
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconCopy,
  IconDownload,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUpload,
  IconX,
} from "../components/Icons.js";
import { NoHostNote } from "../components/NoHostNote.js";
import {
  addLocalGrant,
  exportAccessBook,
  importAccessBook,
  listLocalGrants,
  removeLocalGrant,
} from "../lib/access-book.js";
import {
  AccessError,
  type Delegation,
  type DelegationOffer,
  type MintedOffer,
  type NarrowInput,
  type RelayRequest,
  type TaskDetail,
  type TaskRun,
  approveRelayRequest,
  denyRelayRequest,
  getTask,
  listDelegations,
  listMyOffers,
  listRelayRequests,
  listTasks,
  mintOffer,
  narrowDelegation,
  revokeDelegation,
  revokeOffer,
  terminateTask,
} from "../lib/access.js";
import {
  type BindingTargetKind,
  type Connection,
  bindConnection,
  listConnections,
} from "../lib/connections.js";
import {
  type AccessTab,
  accessImportPath,
  accessIsImportCeremony,
  accessIsNewCeremony,
  accessNewPath,
  accessPath,
  accessTabFromLocation,
} from "../lib/crumbs.js";
import {
  HostSessionError,
  IdentityError,
  identityBase,
  identityFetch,
  identityJson,
  useIdentitySession,
} from "../lib/identity.js";
import { searchVaultListing } from "../lib/keymap.js";
import {
  type BrokerPolicy,
  type DomainEffect,
  type SiteConsent,
  addDomainRule,
  approveConsent,
  isBrokerRestricted,
  loadBrokerPolicy,
  loadConsents,
  pagesPublicBase,
  removeDomainRule,
  revokeConsent,
  setDomainRuleEffect,
  staticSiteExplicitSnippet,
  staticSiteSnippet,
} from "../lib/site-broker.js";
import {
  useHostConfigured,
  useIdentityConfigured,
} from "../lib/use-configured.js";
import { useOnline } from "../lib/use-online.js";
import { useVault } from "../lib/vault/hooks.js";
import type { SecretItem, VaultItem } from "../lib/vault/model.js";
import { GuideTarget, useGuideTarget } from "../tutorial/registry/react.jsx";
import { formatTime } from "./access/format.js";
import { type AuditEvent, Receipts, outcomeChip } from "./access/receipts.js";
import { BindingEditor } from "./connections/BindingEditor.js";
import { ConnectorMark } from "./connections/ConnectorMark.js";
import { PolicyEditor } from "./connections/PolicyEditor.js";
import { type Flash, STATUS_CHIP, errorText } from "./connections/shared.js";
import "./connections.css";
import "./access.css";

const TABS: Array<{ id: AccessTab; label: string; guideId: string }> = [
  { id: "grants", label: "Grants", guideId: "access.grants" },
  { id: "requests", label: "Requests", guideId: "access.requests" },
  { id: "sessions", label: "Sessions", guideId: "access.sessions" },
  { id: "resources", label: "Resources", guideId: "access.resources" },
  { id: "policies", label: "Policies", guideId: "access.policies" },
];

/** One tab, named so a guide can point at it without knowing the markup. */
function AccessTabLink({
  guideId,
  label,
  to,
  current,
}: {
  guideId: string;
  label: string;
  to: string;
  current: boolean;
}) {
  const ref = useGuideTarget<HTMLAnchorElement>(guideId);
  return (
    <Link
      ref={ref}
      to={to}
      role="tab"
      aria-selected={current}
      className={`access-tab${current ? " is-active" : ""}`}
      aria-current={current ? "page" : undefined}
    >
      {label}
    </Link>
  );
}

type GrantTarget =
  | { kind: "connection"; connection: Connection }
  | { kind: "secret"; secret: SecretItem };

function grantCeremonyPath(target: GrantTarget | null): string {
  const base = accessNewPath("grants");
  if (target === null) return base;
  if (target.kind === "connection") {
    return `${base}?connection=${encodeURIComponent(target.connection.connectionId)}`;
  }
  return `${base}?secret=${encodeURIComponent(target.secret.id)}`;
}

type CeremonyStep = "target" | "assign" | "scope" | "mint" | "code";

const CEREMONY_STEPS: Array<{ id: CeremonyStep; label: string }> = [
  { id: "target", label: "Target" },
  { id: "assign", label: "Who" },
  { id: "scope", label: "Scope" },
  { id: "mint", label: "Review" },
];

/** One identity a grant is meant for. */
type GrantRecipient = {
  kind: BindingTargetKind;
  id: string;
};

/** Who a grant is meant for. Named identities are bound to the connection;
 * the time-boxed authority still comes only from the claim. */
type Assignment =
  | { kind: "anyone" }
  | { kind: "bound"; recipients: GrantRecipient[] };

type ScopeInput = {
  actions: string[];
  resources: string[];
  executionMode: "broker" | "relay";
  expiresInSeconds: number;
};

type MintedCode = {
  claimToken: string;
  userCode: string;
  expiresAt: string;
  assignment: Assignment;
  /** Set when an identity binding failed after a successful mint. */
  bindWarning: string | null;
};

function recipientLabel(recipient: GrantRecipient): string {
  return recipient.kind === "identity"
    ? recipient.id
    : `${recipient.kind}:${recipient.id}`;
}

function assignmentLabel(assignment: Assignment): string {
  if (assignment.kind === "anyone") return "Anyone with the code";
  return assignment.recipients.map(recipientLabel).join(", ");
}

/** Human duration for the review screen — never raw seconds. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(seconds / 86_400);
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * Access — the grantor's PAM plane (ADR 0061). Five tabs, one mounted at a
 * time; every action is its own ceremony with a back-link out, never fields
 * appended to a long page. Every list fails soft and reloads on demand.
 */
export function AccessSection() {
  const online = useOnline();
  const location = useLocation();
  const navigate = useNavigate();
  const tab = accessTabFromLocation(location.pathname, location.search);
  const adding = accessIsNewCeremony(location.pathname);
  const importing = accessIsImportCeremony(location.pathname);
  const grantQuery = new URLSearchParams(location.search);
  const preselectConnection = grantQuery.get("connection");
  const preselectSecret = grantQuery.get("secret");
  const [policyFocus, setPolicyFocus] = useState<string | null>(null);
  const [bookEpoch, setBookEpoch] = useState(0);
  const grantRef = useGuideTarget<HTMLAnchorElement>("access.grant-access");

  const openGrant = useCallback(
    (target: GrantTarget | null) => {
      navigate(grantCeremonyPath(target));
    },
    [navigate],
  );

  const openPolicy = useCallback(
    (connectionId: string) => {
      setPolicyFocus(connectionId);
      navigate(accessPath("policies"));
    },
    [navigate],
  );

  const clearPolicyFocus = useCallback(() => setPolicyFocus(null), []);

  useEffect(() => {
    if (tab !== "policies") setPolicyFocus(null);
  }, [tab]);

  function exportBook() {
    const url = URL.createObjectURL(
      new Blob([exportAccessBook()], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "access.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  // Requests and policies are Host-brokered. Grants still add, import and
  // export a local book when there is no Host (ADR 0090). Sessions and
  // Resources each gate only their Host half.
  const hostConfigured = useHostConfigured();

  return (
    <div className="section__inner">
      <header className="section__head">
        <h1>Access</h1>
      </header>

      <div className="access-pathbar">
        <span className="access-pathbar__root">
          <span className="access-pathbar__seg">access</span>
          <span className="access-pathbar__sep">:/</span>
          {importing ? (
            <span className="access-pathbar__seg">import</span>
          ) : adding ? (
            <span className="access-pathbar__seg">new</span>
          ) : tab !== "grants" ? (
            <span className="access-pathbar__seg">{tab}</span>
          ) : null}
        </span>
        <div
          className="access-pathbar__keys"
          role="toolbar"
          aria-label="Access actions"
        >
          <Link
            ref={grantRef}
            className="icon-btn icon-btn--sm"
            to={accessNewPath(tab)}
            aria-label="Grant access"
            title="Grant access"
          >
            <IconPlus size={15} />
          </Link>
          <Link
            className="icon-btn icon-btn--sm"
            to={accessImportPath()}
            aria-label="Import grants"
            title="Import grants"
          >
            <IconUpload size={15} />
          </Link>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Export grants"
            title="Export grants"
            onClick={exportBook}
          >
            <IconDownload size={15} />
          </button>
          <button
            type="button"
            className="access-pathbar__key"
            aria-label="Search"
            title="Search (/)"
            aria-keyshortcuts="/"
            onClick={() => searchVaultListing()}
          >
            /
          </button>
        </div>
      </div>

      <nav className="access-tabs" role="tablist" aria-label="Access views">
        {TABS.map(({ id, label, guideId }) => (
          <AccessTabLink
            key={id}
            guideId={guideId}
            label={label}
            to={accessPath(id)}
            current={tab === id}
          />
        ))}
      </nav>

      {importing ? (
        <ImportAccessCeremony
          onDone={() => {
            setBookEpoch((value) => value + 1);
            navigate(accessPath("grants"));
          }}
        />
      ) : null}
      {adding ? (
        <GuideTarget id="access.grant-ceremony">
          <GrantCeremony
            online={online}
            hostConfigured={hostConfigured}
            preselectConnection={preselectConnection}
            preselectSecret={preselectSecret}
            onClose={() => {
              setBookEpoch((value) => value + 1);
              navigate(accessPath("grants"));
            }}
          />
        </GuideTarget>
      ) : null}

      {!adding && !importing && tab === "grants" ? (
        <>
          {hostConfigured ? null : (
            <p className="hint">
              No Host connected — grants on this device still add, import and
              export from{" "}
              <Link to="/settings/connectivity">Settings → Connectivity</Link>.
            </p>
          )}
          <GrantsPanel
            key={bookEpoch}
            online={online}
            hostConfigured={hostConfigured}
          />
        </>
      ) : null}
      {!adding && !importing && tab === "requests" ? (
        !hostConfigured ? (
          <NoHostNote what="Requests are agents asking a Host for authority it has not already granted." />
        ) : (
          <GuideTarget id="access.relay">
            <RequestsPanel online={online} />
          </GuideTarget>
        )
      ) : null}
      {!adding && !importing && tab === "sessions" ? (
        <SessionsPanel online={online} />
      ) : null}
      {!adding && !importing && tab === "resources" ? (
        <ResourcesPanel
          online={online}
          onGrant={openGrant}
          onPolicy={openPolicy}
        />
      ) : null}
      {!adding && !importing && tab === "policies" ? (
        !hostConfigured ? (
          <NoHostNote what="A policy narrows what a Host will do with a connection, so it lives beside the connection." />
        ) : (
          <PoliciesPanel
            online={online}
            focusId={policyFocus}
            onFocusUsed={clearPolicyFocus}
          />
        )
      ) : null}
    </div>
  );
}

function accessErrorText<Thrown>(error: Thrown): string {
  if (error instanceof HostSessionError) return errorText(error);
  if (error instanceof AccessError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function isSecret(item: VaultItem): item is SecretItem {
  return item.kind === "secret" && item.deletedAt === null;
}

function targetName(target: GrantTarget): string {
  return target.kind === "connection"
    ? target.connection.displayName
    : target.secret.name;
}

function parseCsv(text: string): string[] {
  return text
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/* ------------------------------------------------------------------ grants */

function GrantsPanel({
  online,
  hostConfigured,
}: {
  online: boolean;
  hostConfigured?: boolean;
}) {
  const [delegations, setDelegations] = useState<Delegation[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [localEpoch, setLocalEpoch] = useState(0);
  const run = useRef(0);
  const now = useNow(30_000);

  const load = useCallback(async () => {
    const id = ++run.current;
    if (!hostConfigured) {
      setDelegations([]);
      setConnections([]);
      setError(null);
      return;
    }
    try {
      const [rows, conns] = await Promise.all([
        listDelegations(),
        listConnections(),
      ]);
      if (run.current !== id) return;
      setDelegations(rows);
      setConnections(conns);
      setError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setDelegations(null);
      setError(accessErrorText(caught));
    }
  }, [hostConfigured]);

  useEffect(() => {
    void load();
  }, [load]);

  void localEpoch;
  const localGrants = listLocalGrants();
  const active = useMemo(
    () =>
      (delegations ?? []).filter((delegation) => delegation.revokedAt === null),
    [delegations],
  );

  const nameOf = useCallback(
    (connectionId: string) =>
      connections.find((connection) => connection.connectionId === connectionId)
        ?.displayName ?? connectionId,
    [connections],
  );

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Grants</h2>
        </div>
        <div className="actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => void load()}
            disabled={!online}
            title="Reload grants"
            aria-label="Reload grants"
          >
            <IconRefresh />
          </button>
        </div>
      </div>

      <div className="panel__body">
        {error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : null}

        {delegations === null && !error ? (
          <output className="note">Asking the Host…</output>
        ) : null}

        {delegations !== null &&
        active.length === 0 &&
        localGrants.length === 0 ? (
          <p className="hint">No active grants.</p>
        ) : null}
        {localGrants.length > 0 ? (
          <ul className="access-resources" aria-label="Local grants">
            {localGrants.map((grant) => (
              <li className="access-resource" key={grant.id}>
                <div className="access-resource__main">
                  <div className="access-resource__id">
                    <h3>{grant.title}</h3>
                    <code className="access-ref">{grant.resource}</code>
                  </div>
                  <span className="access-resource__meta">{grant.mode}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${grant.title}`}
                    title={`Remove ${grant.title}`}
                    onClick={() => {
                      removeLocalGrant(grant.id);
                      setLocalEpoch((value) => value + 1);
                      void load();
                    }}
                  >
                    <IconTrash />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {active.length > 0 ? (
          <div className="scroll-x">
            <table className="table access-grants">
              <thead>
                <tr>
                  <th scope="col">Claimant</th>
                  <th scope="col">Connection</th>
                  <th scope="col">Actions</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Manage</th>
                </tr>
              </thead>
              <tbody>
                {active.map((delegation) => (
                  <GrantRow
                    key={delegation.id}
                    delegation={delegation}
                    connectionName={nameOf(delegation.connectionId)}
                    now={now}
                    online={online}
                    onFlash={setFlash}
                    onChanged={() => void load()}
                  />
                ))}
              </tbody>
            </table>
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

function GrantRow({
  delegation,
  connectionName,
  now,
  online,
  onFlash,
  onChanged,
}: {
  delegation: Delegation;
  connectionName: string;
  now: number;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onChanged: () => void;
}) {
  const [manage, setManage] = useState<"none" | "confirm" | "narrow">("none");
  const [busy, setBusy] = useState(false);

  async function revoke() {
    setBusy(true);
    try {
      await revokeDelegation(delegation.id);
      onFlash({
        tone: "ok",
        text: `Grant to ${delegation.claimantSubject} revoked.`,
      });
      onChanged();
    } catch (caught) {
      onFlash({ tone: "err", text: accessErrorText(caught) });
      setBusy(false);
    } finally {
      setManage("none");
    }
  }

  return (
    <>
      <tr>
        <td>
          <code>{delegation.claimantSubject}</code>
        </td>
        <td>{connectionName}</td>
        <td>
          <span className="access-chips">
            {delegation.actions.map((action) => (
              <span className="chip" key={action}>
                {action}
              </span>
            ))}
          </span>
        </td>
        <td>
          <span className="chip">{delegation.executionMode}</span>
        </td>
        <td>{countdown(delegation.expiresAt, now)}</td>
        <td>
          <div className="actions">
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={busy || !online}
              onClick={() =>
                setManage(manage === "confirm" ? "none" : "confirm")
              }
            >
              Revoke
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy || !online}
              onClick={() => setManage(manage === "narrow" ? "none" : "narrow")}
            >
              Narrow
            </button>
          </div>
        </td>
      </tr>
      {manage === "confirm" ? (
        <tr>
          <td colSpan={6}>
            <div className="conn-confirm">
              <p>
                Revoke the grant to{" "}
                <strong>{delegation.claimantSubject}</strong>?
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  disabled={busy}
                  onClick={() => void revoke()}
                >
                  {busy ? "Revoking…" : "Revoke grant"}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setManage("none")}
                >
                  Keep it
                </button>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
      {manage === "narrow" ? (
        <tr>
          <td colSpan={6}>
            <NarrowForm
              delegation={delegation}
              online={online}
              onFlash={onFlash}
              onDone={() => {
                setManage("none");
                onChanged();
              }}
              onCancel={() => setManage("none")}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function NarrowForm({
  delegation,
  online,
  onFlash,
  onDone,
  onCancel,
}: {
  delegation: Delegation;
  online: boolean;
  onFlash: (flash: Flash) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [actionsText, setActionsText] = useState(delegation.actions.join(", "));
  const [resourcesText, setResourcesText] = useState(
    delegation.resources.join(", "),
  );
  const [secondsText, setSecondsText] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    // An emptied field means "leave it as granted" — the server keeps any
    // field the request omits, and an empty list would read as "nothing".
    const input: NarrowInput = {};
    if (actionsText.trim() !== "") input.actions = parseCsv(actionsText);
    if (resourcesText.trim() !== "") input.resources = parseCsv(resourcesText);
    const seconds = Number(secondsText);
    if (secondsText.trim() !== "" && Number.isFinite(seconds) && seconds > 0) {
      input.expiresInSeconds = Math.floor(seconds);
    }
    setBusy(true);
    try {
      await narrowDelegation(delegation.id, input);
      onFlash({ tone: "ok", text: "Grant narrowed." });
      onDone();
    } catch (caught) {
      onFlash({ tone: "err", text: accessErrorText(caught) });
      setBusy(false);
    }
  }

  return (
    <form className="access-narrow" onSubmit={submit}>
      <div className="field">
        <label className="label" htmlFor={`narrow-actions-${delegation.id}`}>
          Actions
        </label>
        <input
          id={`narrow-actions-${delegation.id}`}
          value={actionsText}
          onChange={(event) => setActionsText(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor={`narrow-resources-${delegation.id}`}>
          Resources
        </label>
        <input
          id={`narrow-resources-${delegation.id}`}
          value={resourcesText}
          onChange={(event) => setResourcesText(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor={`narrow-seconds-${delegation.id}`}>
          Shorter expiry (seconds)
        </label>
        <input
          id={`narrow-seconds-${delegation.id}`}
          value={secondsText}
          onChange={(event) => setSecondsText(event.target.value)}
          inputMode="numeric"
          placeholder="600"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
      </div>
      <div className="actions">
        <button
          type="submit"
          className="btn btn--sm btn--primary"
          disabled={busy || !online}
        >
          {busy ? "Narrowing…" : "Apply"}
        </button>
        <button type="button" className="btn btn--sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------- ceremony: grant access */

function localDeviceConnection(): Connection {
  return {
    connectionId: "conn_local",
    connectionRef: "local",
    logicalName: "local",
    displayName: "this device",
    providerId: "local",
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "",
    projectId: null,
    ownerKind: "device",
    shareability: "private",
    requestedScopes: [],
    grantedScopes: [],
    accountLabel: null,
    expiresAt: null,
    refreshable: false,
    lastRefreshedAt: null,
    maxInvokeLevel: 0,
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    bindings: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function ImportAccessCeremony({ onDone }: { onDone: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const raw = isString(reader.result) ? reader.result : "";
      try {
        const { added } = importAccessBook(raw);
        if (added === 0) {
          setError("No new grants in that file.");
          return;
        }
        onDone();
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "That file is not an access book.",
        );
      }
    };
    reader.onerror = () => {
      setError("Could not read that file.");
    };
    reader.readAsText(file);
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Import grants</h2>
        </div>
      </div>
      <div className="panel__body access-add-kinds">
        <button
          type="button"
          className="icon-btn"
          aria-label="Import from a file"
          title="Import from a file"
          onClick={() => inputRef.current?.click()}
        >
          <IconUpload size={16} />
        </button>
        <span className="go-verb">File</span>
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            onFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      {error ? (
        <p className="note note--err" role="alert">
          <IconAlert /> {error}
        </p>
      ) : null}
    </section>
  );
}

function GrantCeremony({
  online,
  hostConfigured,
  preselectConnection,
  preselectSecret,
  onClose,
}: {
  online: boolean;
  hostConfigured: boolean;
  preselectConnection: string | null;
  preselectSecret: string | null;
  onClose: () => void;
}) {
  const vault = useVault();
  const [step, setStep] = useState<CeremonyStep>("target");
  const [target, setTarget] = useState<GrantTarget | null>(null);
  const [assignment, setAssignment] = useState<Assignment>({ kind: "anyone" });
  const [scope, setScope] = useState<ScopeInput | null>(null);
  const [code, setCode] = useState<MintedCode | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    if (!hostConfigured) {
      setConnections([]);
      setLoadError(null);
      return;
    }
    try {
      const rows = await listConnections();
      if (run.current !== id) return;
      setConnections(rows);
      setLoadError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setConnections([]);
      setLoadError(accessErrorText(caught));
    }
  }, [hostConfigured]);

  useEffect(() => {
    void load();
  }, [load]);

  const secrets = useMemo(
    () =>
      vault.status === "unlocked"
        ? vault.items
            .filter(isSecret)
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [vault.items, vault.status],
  );

  useEffect(() => {
    if (target !== null) return;
    if (preselectConnection && connections) {
      const found = connections.find(
        (connection) => connection.connectionId === preselectConnection,
      );
      if (found) {
        setTarget({ kind: "connection", connection: found });
        setStep("assign");
      }
      return;
    }
    if (preselectSecret) {
      const found = secrets.find((item) => item.id === preselectSecret);
      if (found) {
        setTarget({ kind: "secret", secret: found });
        setStep("assign");
      }
    }
  }, [connections, preselectConnection, preselectSecret, secrets, target]);

  // A secret grants through its ConnectionRef; the offer item needs the
  // connection's id, so the ref has to resolve against the Host's list.
  const resolved = useMemo(() => {
    if (target === null || connections === null) return null;
    if (target.kind === "connection") return target.connection;
    return (
      connections.find(
        (connection) =>
          connection.connectionRef === target.secret.connectionRef,
      ) ?? null
    );
  }, [target, connections]);

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Grant access</h2>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Cancel"
          title="Cancel"
          onClick={onClose}
        >
          <IconX size={15} />
        </button>
      </div>

      <div className="panel__body">
        {step !== "code" ? (
          <ol className="grant-steps" aria-label="Grant access steps">
            {CEREMONY_STEPS.map((entry) => (
              <li
                key={entry.id}
                className={
                  entry.id === step
                    ? "grant-steps__step is-current"
                    : "grant-steps__step"
                }
                aria-current={entry.id === step ? "step" : undefined}
              >
                {entry.label}
              </li>
            ))}
          </ol>
        ) : null}
        {step === "target" ? (
          <TargetStep
            connections={connections}
            loadError={loadError}
            secrets={secrets}
            vaultStatus={vault.status}
            onPick={(picked) => {
              setTarget(picked);
              setStep("assign");
            }}
            onRetry={() => void load()}
          />
        ) : null}
        {step === "assign" && target !== null ? (
          <AssignStep
            target={target}
            connection={resolved}
            onBack={
              preselectConnection || preselectSecret
                ? null
                : () => setStep("target")
            }
            onAssign={(next) => {
              setAssignment(next);
              setStep("scope");
            }}
          />
        ) : null}
        {step === "scope" && target !== null ? (
          <ScopeStep
            target={target}
            connection={resolved}
            connectionsReady={connections !== null}
            online={online}
            onBack={() => setStep("assign")}
            onScope={(next) => {
              setScope(next);
              setStep("mint");
            }}
          />
        ) : null}
        {step === "mint" && target !== null && scope !== null ? (
          <MintStep
            target={target}
            connection={resolved}
            assignment={assignment}
            scope={scope}
            online={online}
            onBack={() => setStep("scope")}
            onMinted={(minted, bindWarning) => {
              setCode({
                claimToken: minted.claimToken,
                userCode: minted.userCode,
                expiresAt: minted.offer.expiresAt,
                assignment,
                bindWarning,
              });
              setStep("code");
            }}
          />
        ) : null}
        {step === "code" && code !== null ? (
          <CodeCard code={code} onDone={onClose} />
        ) : null}
      </div>
    </section>
  );
}

function connectionMatches(connection: Connection, query: string): boolean {
  const haystack = [
    connection.displayName,
    connection.logicalName,
    connection.connectionRef,
    connection.providerId,
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function secretMatches(item: SecretItem, query: string): boolean {
  const haystack = [item.name, item.connectionRef].join("\n").toLowerCase();
  return haystack.includes(query);
}

function TargetStep({
  connections,
  loadError,
  secrets,
  vaultStatus,
  onPick,
  onRetry,
}: {
  connections: Connection[] | null;
  loadError: string | null;
  secrets: SecretItem[];
  vaultStatus: string;
  onPick: (target: GrantTarget) => void;
  onRetry: () => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shownConnections = (connections ?? []).filter(
    (connection) => !needle || connectionMatches(connection, needle),
  );
  const shownSecrets = secrets.filter(
    (item) => !needle || secretMatches(item, needle),
  );

  return (
    <>
      <div className="field access-search">
        <label className="label" htmlFor="grant-target-search">
          <IconSearch /> Search targets
        </label>
        <input
          id="grant-target-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name or reference…"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {loadError ? (
        <p className="note note--err" role="alert">
          <IconAlert /> {loadError}{" "}
          <button type="button" className="btn btn--sm" onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : null}

      {connections === null && !loadError ? (
        <output className="note">Asking the Host…</output>
      ) : null}

      <h3 className="access-group__label">This device</h3>
      <ul className="access-targets">
        <li>
          <button
            type="button"
            className="access-target"
            onClick={() =>
              onPick({
                kind: "connection",
                connection: localDeviceConnection(),
              })
            }
          >
            <span className="access-target__name">this device</span>
            <code className="access-ref">local</code>
          </button>
        </li>
      </ul>

      {connections !== null &&
      (shownConnections.length > 0 || connections.length > 0 || needle) ? (
        <>
          <h3 className="access-group__label">Connections</h3>
          {shownConnections.length > 0 ? (
            <ul className="access-targets">
              {shownConnections.map((connection) => (
                <li key={connection.connectionId}>
                  <button
                    type="button"
                    className="access-target"
                    onClick={() => onPick({ kind: "connection", connection })}
                  >
                    <span className="access-target__name">
                      {connection.displayName}
                    </span>
                    <code className="access-ref">
                      {connection.connectionRef}
                    </code>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No connections match.</p>
          )}
        </>
      ) : null}

      {vaultStatus === "unlocked" ? (
        <>
          <h3 className="access-group__label">Secrets</h3>
          {shownSecrets.length > 0 ? (
            <ul className="access-targets">
              {shownSecrets.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="access-target"
                    onClick={() => onPick({ kind: "secret", secret: item })}
                  >
                    <span className="access-target__name">{item.name}</span>
                    <code className="access-ref">
                      {item.connectionRef.trim() || "—"}
                    </code>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No secrets match.</p>
          )}
        </>
      ) : vaultStatus === "locked" ? (
        <p className="hint">Unlock the vault to grant secrets.</p>
      ) : null}
    </>
  );
}

const DURATION_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: "1h", seconds: 3_600 },
  { label: "8h", seconds: 28_800 },
  { label: "1d", seconds: 86_400 },
  { label: "1w", seconds: 604_800 },
];

function ScopeStep({
  target,
  connection,
  connectionsReady,
  online,
  onBack,
  onScope,
}: {
  target: GrantTarget;
  connection: Connection | null;
  connectionsReady: boolean;
  online: boolean;
  onBack: () => void;
  onScope: (scope: ScopeInput) => void;
}) {
  const secret = target.kind === "secret" ? target.secret : null;
  const ceiling = secret?.ceiling ?? [];
  const ceilingActions = new Set(ceiling.map((grant) => grant.action));
  const ceilingResources = new Set(ceiling.map((grant) => grant.resource));

  const [actionsText, setActionsText] = useState(() =>
    [...ceilingActions].join(", "),
  );
  const [resourcesText, setResourcesText] = useState(() =>
    [...ceilingResources].join(", "),
  );
  const [mode, setMode] = useState<"broker" | "relay">("broker");
  const [preset, setPreset] = useState(3_600);
  const [customText, setCustomText] = useState("");

  const actions = parseCsv(actionsText);
  const resources = parseCsv(resourcesText);
  // A secret's scope may only ever narrow its ceiling — anything the ceiling
  // does not imply blocks the step (ADR 0019).
  const outside =
    secret === null
      ? []
      : [
          ...actions.filter((action) => !ceilingActions.has(action)),
          ...resources.filter((resource) => !ceilingResources.has(resource)),
        ];
  const customSeconds = Number(customText);
  const customValid =
    customText.trim() !== "" &&
    Number.isInteger(customSeconds) &&
    customSeconds > 0;
  const customInvalid = customText.trim() !== "" && !customValid;
  const expiresInSeconds = customValid ? customSeconds : preset;
  const unresolvable =
    secret !== null && connectionsReady && connection === null;
  const emptySecretScope =
    secret !== null && (actions.length === 0 || resources.length === 0);
  const blocked =
    outside.length > 0 || unresolvable || emptySecretScope || customInvalid;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    onScope({ actions, resources, executionMode: mode, expiresInSeconds });
  }

  return (
    <form onSubmit={submit}>
      <p className="access-ceremony__target">
        <strong>{targetName(target)}</strong>{" "}
        <code className="access-ref">
          {connection?.connectionRef ?? secret?.connectionRef ?? ""}
        </code>
      </p>

      {secret !== null ? (
        <div className="access-ceiling-context">
          <span className="access-secret__label">Ceiling</span>
          {ceiling.length > 0 ? (
            <span className="access-chips">
              {ceiling.map((grant) => (
                <span className="chip" key={grant.id}>
                  {grant.action} → {grant.resource}
                </span>
              ))}
            </span>
          ) : (
            <span className="hint">Empty.</span>
          )}
        </div>
      ) : null}

      <div className="field">
        <label className="label" htmlFor="grant-actions">
          Actions
        </label>
        <input
          id="grant-actions"
          value={actionsText}
          onChange={(event) => setActionsText(event.target.value)}
          placeholder="repository.read, repository.write"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="grant-resources">
          Resources
        </label>
        <input
          id="grant-resources"
          value={resourcesText}
          onChange={(event) => setResourcesText(event.target.value)}
          placeholder="repo:acme/*"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      <fieldset className="access-fieldset">
        <legend className="label">Execution mode</legend>
        <label className="access-radio">
          <input
            type="radio"
            name="grant-mode"
            value="broker"
            checked={mode === "broker"}
            onChange={() => setMode("broker")}
          />
          Broker
        </label>
        <label className="access-radio">
          <input
            type="radio"
            name="grant-mode"
            value="relay"
            checked={mode === "relay"}
            onChange={() => setMode("relay")}
          />
          Relay — each use needs approval
        </label>
      </fieldset>

      <fieldset className="access-fieldset">
        <legend className="label">Duration</legend>
        <div className="access-duration">
          {DURATION_PRESETS.map((option) => (
            <button
              key={option.seconds}
              type="button"
              className={`btn btn--sm${
                preset === option.seconds && customText.trim() === ""
                  ? " is-active"
                  : " btn--ghost"
              }`}
              aria-pressed={
                preset === option.seconds && customText.trim() === ""
              }
              onClick={() => {
                setPreset(option.seconds);
                setCustomText("");
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="field">
          <label className="label" htmlFor="grant-custom-seconds">
            Custom seconds
          </label>
          <input
            id="grant-custom-seconds"
            value={customText}
            onChange={(event) => setCustomText(event.target.value)}
            inputMode="numeric"
            placeholder="3600"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </fieldset>

      {outside.length > 0 ? (
        <p className="note note--err" role="alert">
          <IconAlert /> Outside the ceiling: {outside.join(", ")}.
        </p>
      ) : null}
      {emptySecretScope ? (
        <p className="note note--err" role="alert">
          <IconAlert /> Keep at least one action and one resource.
        </p>
      ) : null}
      {unresolvable ? (
        <p className="note note--err" role="alert">
          <IconAlert /> No Host connection matches this secret&apos;s reference.
        </p>
      ) : null}
      {customInvalid ? (
        <p className="note note--err" role="alert">
          <IconAlert /> Custom seconds must be a positive whole number.
        </p>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={onBack}
        >
          ← Target
        </button>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={blocked || !online}
        >
          Continue
        </button>
      </div>
    </form>
  );
}

const RECIPIENT_KINDS: Array<{ id: BindingTargetKind; label: string }> = [
  { id: "agent", label: "Agent" },
  { id: "identity", label: "Person" },
  { id: "device", label: "Device" },
  { id: "group", label: "Group" },
  { id: "project", label: "Project" },
  { id: "organization", label: "Organization" },
];

function AssignStep({
  target,
  connection,
  onBack,
  onAssign,
}: {
  target: GrantTarget;
  connection: Connection | null;
  onBack: (() => void) | null;
  onAssign: (assignment: Assignment) => void;
}) {
  const grantees = target.kind === "secret" ? target.secret.grantees : [];
  const boundAgents = (connection?.bindings ?? [])
    .filter((binding) => binding.targetKind === "agent")
    .map((binding) => binding.targetId);
  const suggestions = [...new Set([...grantees, ...boundAgents])];
  const [mode, setMode] = useState<"specific" | "anyone">(
    grantees.length > 0 ? "specific" : "anyone",
  );
  // A secret's grantees are its declared allow-list — they prefill the
  // recipient list (removable), never silently required.
  const [recipients, setRecipients] = useState<GrantRecipient[]>(() =>
    grantees.map((id) => ({ kind: "agent", id })),
  );
  const [kind, setKind] = useState<BindingTargetKind>("agent");
  const [idText, setIdText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function addRecipient() {
    const id = idText.trim();
    if (id === "") {
      setProblem("Enter an id first.");
      return;
    }
    if (
      kind === "agent" &&
      target.kind === "secret" &&
      grantees.length > 0 &&
      !grantees.includes(id)
    ) {
      setProblem(`Not in this secret's grantees: ${grantees.join(", ")}.`);
      return;
    }
    if (recipients.some((entry) => entry.kind === kind && entry.id === id)) {
      setProblem("Already added.");
      return;
    }
    setRecipients([...recipients, { kind, id }]);
    setIdText("");
    setProblem(null);
  }

  const ready = mode === "anyone" || recipients.length > 0;

  function proceed() {
    if (mode === "anyone") onAssign({ kind: "anyone" });
    else onAssign({ kind: "bound", recipients });
  }

  return (
    <div>
      <fieldset className="grant-choices" aria-label="Who is this grant for">
        <button
          type="button"
          className={
            mode === "specific" ? "grant-choice is-on" : "grant-choice"
          }
          onClick={() => setMode("specific")}
        >
          Specific identities
        </button>
        <button
          type="button"
          className={mode === "anyone" ? "grant-choice is-on" : "grant-choice"}
          onClick={() => setMode("anyone")}
        >
          Anyone with the code
        </button>
      </fieldset>

      {mode === "specific" ? (
        <div>
          {recipients.length > 0 ? (
            <ul className="grant-recipients" aria-label="Grant recipients">
              {recipients.map((recipient) => (
                <li
                  key={`${recipient.kind}:${recipient.id}`}
                  className="grant-recipients__chip"
                >
                  {recipientLabel(recipient)}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${recipientLabel(recipient)}`}
                    title={`Remove ${recipientLabel(recipient)}`}
                    onClick={() =>
                      setRecipients(
                        recipients.filter(
                          (entry) =>
                            !(
                              entry.kind === recipient.kind &&
                              entry.id === recipient.id
                            ),
                        ),
                      )
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No identities yet — add at least one.</p>
          )}

          <div className="grant-recipients__add">
            <select
              aria-label="Identity kind"
              value={kind}
              onChange={(event) => {
                const next = RECIPIENT_KINDS.find(
                  (entry) => entry.id === event.target.value,
                );
                if (next) setKind(next.id);
                setProblem(null);
              }}
            >
              {RECIPIENT_KINDS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <input
              aria-label="Identity id"
              value={idText}
              list="grant-recipient-suggestions"
              placeholder={
                kind === "agent"
                  ? "deploy-bot"
                  : kind === "identity"
                    ? "prn_…"
                    : `${kind} id`
              }
              onChange={(event) => setIdText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addRecipient();
                }
              }}
            />
            <datalist id="grant-recipient-suggestions">
              {suggestions.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <button
              type="button"
              className="btn btn--sm"
              onClick={addRecipient}
            >
              Add
            </button>
          </div>
          {problem ? (
            <p className="note note--err" role="alert">
              <IconAlert /> {problem}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="actions">
        {onBack ? (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onBack}
          >
            ← Target
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--primary"
          disabled={!ready}
          onClick={proceed}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

function MintStep({
  target,
  connection,
  assignment,
  scope,
  online,
  onBack,
  onMinted,
}: {
  target: GrantTarget;
  connection: Connection | null;
  assignment: Assignment;
  scope: ScopeInput;
  online: boolean;
  onBack: () => void;
  onMinted: (minted: MintedOffer, bindWarning: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mint() {
    setBusy(true);
    setError(null);
    const mintLocal = (bindWarning: string | null = null) => {
      const record = addLocalGrant({
        title: targetName(target),
        claimant:
          assignment.kind === "anyone" ? "anyone" : assignmentLabel(assignment),
        resource: connection?.connectionRef ?? targetName(target),
        actions: scope.actions,
        mode: scope.executionMode,
        expiresInSeconds: scope.expiresInSeconds,
      });
      const minted: MintedOffer = {
        claimToken: record.id,
        userCode: record.id.replace(/-/g, "").slice(-8).toUpperCase(),
        offer: {
          id: record.id,
          state: "pending",
          manifestDigest: record.id,
          expiresAt: record.expiresAt,
          items: [],
        },
      };
      onMinted(minted, bindWarning);
    };
    try {
      if (connection === null || connection.connectionId === "conn_local") {
        mintLocal();
        return;
      }
      const minted = await mintOffer({
        items: [
          {
            connectionId: connection.connectionId,
            // Empty scope lists stay off the wire so the server defaults
            // (provider vocabulary, every resource) apply instead.
            actions: scope.actions.length > 0 ? scope.actions : undefined,
            resources: scope.resources.length > 0 ? scope.resources : undefined,
            expiresInSeconds: scope.expiresInSeconds,
            executionMode: scope.executionMode,
          },
        ],
      });
      // The mint succeeded; naming the identities against the connection is
      // additive and must not sink the grant when one of them fails.
      let bindWarning: string | null = null;
      if (assignment.kind === "bound") {
        const failures: string[] = [];
        for (const recipient of assignment.recipients) {
          const already = connection.bindings.some(
            (binding) =>
              binding.targetKind === recipient.kind &&
              binding.targetId === recipient.id,
          );
          if (already) continue;
          try {
            await bindConnection(connection.connectionId, {
              targetKind: recipient.kind,
              targetId: recipient.id,
            });
          } catch (caught) {
            failures.push(
              `${recipientLabel(recipient)} (${accessErrorText(caught)})`,
            );
          }
        }
        if (failures.length > 0) {
          bindWarning = `Minted, but the identity could not be bound: ${failures.join("; ")}`;
        }
      }
      onMinted(minted, bindWarning);
    } catch (caught) {
      setError(accessErrorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <dl className="grant-review">
        <div className="grant-review__row">
          <dt>For</dt>
          <dd>
            {assignmentLabel(assignment)}
            {assignment.kind !== "anyone" ? (
              <span className="grant-review__note"> — will be bound</span>
            ) : null}
          </dd>
        </div>
        <div className="grant-review__row">
          <dt>Target</dt>
          <dd>{targetName(target)}</dd>
        </div>
        <div className="grant-review__row">
          <dt>Connection</dt>
          <dd>
            <code>{connection?.connectionRef ?? "—"}</code>
          </dd>
        </div>
        <div className="grant-review__row">
          <dt>Actions</dt>
          <dd>{scope.actions.join(", ") || "Provider defaults"}</dd>
        </div>
        <div className="grant-review__row">
          <dt>Resources</dt>
          <dd>{scope.resources.join(", ") || "All resources"}</dd>
        </div>
        <div className="grant-review__row">
          <dt>Approval</dt>
          <dd>
            {scope.executionMode === "relay"
              ? "Relay — each use needs approval"
              : "Brokered"}
          </dd>
        </div>
        <div className="grant-review__row">
          <dt>Duration</dt>
          <dd>{formatDuration(scope.expiresInSeconds)}</dd>
        </div>
      </dl>

      {error ? (
        <p className="note note--err" role="alert">
          <IconAlert /> {error}
        </p>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={onBack}
        >
          ← Scope
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={
            busy ||
            (connection !== null &&
              connection.connectionId !== "conn_local" &&
              !online)
          }
          onClick={() => void mint()}
        >
          {busy ? "Minting…" : "Mint offer"}
        </button>
      </div>
    </div>
  );
}

function CodeCard({ code, onDone }: { code: MintedCode; onDone: () => void }) {
  const { copy, copied } = useCopy();
  const now = useNow(30_000);

  return (
    <div>
      <div className="access-code">
        {code.assignment.kind !== "anyone" ? (
          <div className="access-code__row">
            <span className="access-code__label">For</span>
            <span>{assignmentLabel(code.assignment)}</span>
          </div>
        ) : null}
        <div className="access-code__row">
          <span className="access-code__label">Claim token</span>
          <code className="access-code__value">{code.claimToken}</code>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void copy(code.claimToken, "token")}
            title="Copy claim token"
            aria-label="Copy claim token"
          >
            {copied === "token" ? <IconCheck /> : <IconCopy />}
          </button>
        </div>
        <div className="access-code__row">
          <span className="access-code__label">User code</span>
          <code className="access-code__user">{code.userCode}</code>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void copy(code.userCode, "code")}
            title="Copy user code"
            aria-label="Copy user code"
          >
            {copied === "code" ? <IconCheck /> : <IconCopy />}
          </button>
        </div>
        <p className="access-code__expiry">
          Offer expires {countdown(code.expiresAt, now)}.
        </p>
      </div>

      {code.bindWarning ? (
        <p className="note note--warn">
          <IconAlert /> {code.bindWarning}
        </p>
      ) : code.assignment.kind !== "anyone" ? (
        <p className="hint">Bound to the connection.</p>
      ) : null}

      <div className="actions actions--end">
        <button type="button" className="btn btn--primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- requests */

function RequestsPanel({ online }: { online: boolean }) {
  const [requests, setRequests] = useState<RelayRequest[] | null>(null);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [offers, setOffers] = useState<DelegationOffer[] | null>(null);
  const [offersError, setOffersError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const run = useRef(0);
  const now = useNow(30_000);

  const load = useCallback(async () => {
    const id = ++run.current;
    // The inbox and my offers fail independently — one down endpoint must not
    // blank the other list.
    const [inbox, mine] = await Promise.allSettled([
      listRelayRequests(),
      listMyOffers(),
    ]);
    if (run.current !== id) return;
    if (inbox.status === "fulfilled") {
      setRequests(inbox.value);
      setRequestsError(null);
    } else {
      setRequests(null);
      setRequestsError(accessErrorText(inbox.reason));
    }
    if (mine.status === "fulfilled") {
      setOffers(mine.value);
      setOffersError(null);
    } else {
      setOffers(null);
      setOffersError(accessErrorText(mine.reason));
    }
  }, []);

  useEffect(() => {
    if (!online) return;
    void load();
  }, [load, online]);

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
      void load();
    } catch (caught) {
      // A 404 means the request was already decided or lapsed; the row is
      // stale, so it collapses instead of asking to be decided again.
      if (caught instanceof AccessError && caught.status === 404) {
        setRequests((current) =>
          (current ?? []).filter((row) => row.id !== request.id),
        );
      }
      setFlash({ tone: "err", text: accessErrorText(caught) });
    } finally {
      setBusyId(null);
    }
  }

  async function retract(offer: DelegationOffer) {
    setBusyId(offer.id);
    setFlash(null);
    try {
      await revokeOffer(offer.id);
      setFlash({ tone: "ok", text: "Offer revoked." });
      void load();
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
          <h2>Requests</h2>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void load()}
          disabled={!online}
          title="Reload requests"
          aria-label="Reload requests"
        >
          <IconRefresh />
        </button>
      </div>

      <div className="panel__body">
        {!online ? (
          <output className="note note--warn">
            <IconAlert /> Offline.
          </output>
        ) : null}

        {requestsError ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {requestsError}
          </p>
        ) : null}

        {requests === null && !requestsError ? (
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
            <h3 className="access-group__label">My offers</h3>
            <ul className="access-requests">
              {offers.map((offer) => (
                <li className="access-request" key={offer.id}>
                  <div className="access-request__top">
                    <h3>
                      <code>{offer.id}</code>
                    </h3>
                    <span className="chip">{offer.state}</span>
                  </div>
                  <p className="access-request__digest">
                    {offer.items
                      .map((item) => item.displayName || item.connectionId)
                      .join(", ")}
                  </p>
                  <p className="access-request__digest">
                    Expires {countdown(offer.expiresAt, now)}.
                  </p>
                  {offer.state === "pending" ? (
                    <div className="actions actions--end">
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        disabled={busyId !== null || !online}
                        onClick={() => void retract(offer)}
                      >
                        {busyId === offer.id ? "Revoking…" : "Revoke"}
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {emptyInbox && emptyOffers ? (
          <p className="hint">Nothing waiting for approval.</p>
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

function SessionsPanel({ online }: { online: boolean }) {
  const session = useIdentitySession();
  // The task list is the Host's; the receipts trail below it is the Identity
  // API's and renders on its own terms (ADR 0090).
  const hostConfigured = useHostConfigured();
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
    if (!online || !hostConfigured) return;
    void load();
  }, [load, online, hostConfigured]);

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
      {hostConfigured ? null : (
        <NoHostNote what="A session is an agent run a Host is carrying out on your behalf." />
      )}

      {!hostConfigured ? null : (
        <section className="panel">
          <div className="panel__head">
            <div>
              <h2>Sessions</h2>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void load()}
              disabled={!online}
              title="Reload sessions"
              aria-label="Reload sessions"
            >
              <IconRefresh />
            </button>
          </div>

          <div className="panel__body">
            {!online ? (
              <output className="note note--warn">
                <IconAlert /> Offline.
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
              <p className="hint">No live sessions.</p>
            ) : null}

            {flash ? (
              <output className={`note note--${flash.tone}`}>
                {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
                <p>{flash.text}</p>
              </output>
            ) : null}
          </div>
        </section>
      )}

      {session ? (
        <Receipts online={online} sessionKey={session.principalId} />
      ) : null}
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
        <output className="note">No capabilities.</output>
      )}
    </div>
  );
}

/* ------------------------------------------------------ sites: identity plane */

/** An origin client as the Identity plane returns it (ADR 0061: a site is a resource). */
type OAuthClient = {
  id: string;
  admissionMode: string;
  displayName: string;
  redirectUris: string[];
  sectorIdentifier: string;
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  allowedScopes: string[];
  allowedResources: string[];
  state: "active" | "suspended" | "revoked";
  createdAt: string;
  updatedAt: string;
};

class SitesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SitesError";
  }
}

function messageFrom(body: BoundaryValue): string | null {
  if (body && isTypeofObject(body) && "message" in body) {
    const value = overlapCast(body).message;
    if (isString(value) && value.trim()) return value;
  }
  return null;
}

function codeFrom(body: BoundaryValue): string {
  if (body && isTypeofObject(body) && "error" in body) {
    const value = overlapCast(body).error;
    if (isString(value) && value.trim()) return value;
  }
  return "unknown_error";
}

function fieldErrorsFrom(body: BoundaryValue): string[] {
  if (!body || !isTypeofObject(body) || !("details" in body)) return [];
  const details = overlapCast(body).details;
  if (!details || !isTypeofObject(details)) return [];
  const out: string[] = [];
  const form = overlapCast(details).formErrors;
  if (Array.isArray(form)) {
    for (const item of form) if (isString(item)) out.push(item);
  }
  const fields = overlapCast(details).fieldErrors;
  if (fields && isTypeofObject(fields)) {
    for (const [key, value] of Object.entries(overlapCast(fields))) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isString(item)) out.push(`${key}: ${item}`);
        }
      }
    }
  }
  return out;
}

/**
 * Site verbs are Identity-plane calls — the same seam the old Sites screen
 * used, never the Host's fetch (the Host knows nothing about origin clients).
 */
async function callIdentity<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await identityFetch(path, init);
  } catch {
    throw new SitesError(
      0,
      "unreachable",
      `Can't reach the Identity API at ${identityBase()}. Start it, or point Pages at a running instance under Settings.`,
    );
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = codeFrom(body);
    const detail = fieldErrorsFrom(body);
    const explained = messageFrom(body);
    if (res.status === 401) {
      throw new SitesError(
        401,
        code,
        "This session is no longer accepted by the Identity plane. Connect again to continue.",
      );
    }
    if (res.status === 404) {
      throw new SitesError(
        404,
        code,
        "That client no longer exists on the Identity plane — it may already have been revoked. Refresh the list to see the current set.",
      );
    }
    throw new SitesError(
      res.status,
      code,
      detail.length > 0
        ? `${explained ?? code} (${detail.join("; ")})`
        : (explained ?? `${code} (HTTP ${res.status})`),
    );
  }
  return overlapCast(body);
}

type OriginCheck =
  | { ok: true; origin: string; host: string }
  | { ok: false; message: string };

/**
 * An OAuth public client is pinned to one origin, so the input has to be an
 * origin and nothing else — anything extra silently changes what gets pinned.
 */
function checkOrigin(raw: string): OriginCheck {
  const value = raw.trim();
  if (!value) {
    return {
      ok: false,
      message:
        "Enter the origin your site is served from, for example https://example.com.",
    };
  }
  if (!/^https?:\/\//i.test(value)) {
    return {
      ok: false,
      message: `Include the scheme: write https://${value.replace(/^\/+/, "")}, not ${value}.`,
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      message: `“${value}” is not a URL the browser can parse.`,
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      message:
        "Remove the credentials (the user:password@ part) — an origin carries none.",
    };
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return {
      ok: false,
      message: `http:// is only allowed for localhost and 127.0.0.1. Use https://${url.hostname} for a public site — an authorization code returned over plain HTTP is interceptable.`,
    };
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return {
      ok: false,
      message: `An origin has no path — drop “${url.pathname}”. The callback path is a separate field below.`,
    };
  }
  if (url.search) {
    return {
      ok: false,
      message: `An origin has no query string — drop “${url.search}”.`,
    };
  }
  if (url.hash) {
    return {
      ok: false,
      message: `An origin has no fragment — drop “${url.hash}”.`,
    };
  }
  if (url.protocol === "https:" && /:443(?:\/|$)/.test(value)) {
    return {
      ok: false,
      message:
        "Drop the default port :443 — https://host already means that, and the browser will send the origin without it.",
    };
  }
  if (url.protocol === "http:" && /:80(?:\/|$)/.test(value)) {
    return {
      ok: false,
      message:
        "Drop the default port :80 — http://host already means that, and the browser will send the origin without it.",
    };
  }
  return { ok: true, origin: url.origin, host: url.host };
}

function normalisePath(raw: string): string {
  const value = raw.trim();
  if (!value) return "/callback";
  return value.startsWith("/") ? value : `/${value}`;
}

/** The origin a client is pinned to, derived from its first redirect URI. */
function siteOriginOf(client: OAuthClient): string {
  const first = client.redirectUris[0];
  if (!first) return client.sectorIdentifier;
  try {
    return new URL(first).origin;
  } catch {
    return client.sectorIdentifier;
  }
}

const SITE_STATE_CHIP = new Map([
  ["active", "chip--ok"],
  ["suspended", "chip--warn"],
  ["revoked", "chip--err"],
]);

function siteStateChip(state: string): string {
  return SITE_STATE_CHIP.get(state) ?? "";
}

function siteMatches(client: OAuthClient, query: string): boolean {
  const haystack = [
    client.displayName,
    client.id,
    client.sectorIdentifier,
    ...client.redirectUris,
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function quoteList(values: string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

type SignInSnippetInput = {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
};

type CallbackSnippetInput = { redirectUri: string };

function buildSignInSnippet(input: SignInSnippetInput): string {
  return `// auth.js — one module, imported by every page that needs the session.
import { createOpenSesame } from "@opensesame/sdk-browser";

export const sesame = createOpenSesame({
  issuer: "${input.issuer}",
  clientId: "${input.clientId}",
  redirectUri: "${input.redirectUri}",
  scopes: [${quoteList(input.scopes)}],
});

// "Sign in with OpenSesame" button. signIn() discovers the authorization
// endpoint, generates the PKCE S256 challenge, and redirects. No secret
// ships to the browser — this client authenticates with none.
document.querySelector("#opensesame-signin")?.addEventListener("click", () => {
  void sesame.signIn();
});`;
}

function buildCallbackSnippet(input: CallbackSnippetInput): string {
  return `// The page served at ${input.redirectUri}
import { sesame } from "./auth.js";

// Verifies state, replays the stored PKCE verifier, and exchanges ?code=
// for tokens. Throws if state does not match or the code is missing.
const session = await sesame.handleRedirectCallback();
console.log("OpenSesame sign-in complete", { sub: session.sub });

// Anywhere else in the site:
const current = await sesame.getSession(); // null when absent or expired
// await sesame.signOut();`;
}

/* --------------------------------------------------------------- resources */

type ResourcesView =
  | { kind: "list" }
  | { kind: "site"; client: OAuthClient }
  | { kind: "register" };

function ResourcesPanel({
  online,
  onGrant,
  onPolicy,
}: {
  online: boolean;
  onGrant: (target: GrantTarget) => void;
  onPolicy: (connectionId: string) => void;
}) {
  const vault = useVault();
  // Only the Connections group here belongs to a Host. The Sites group is the
  // Identity API's, and the snippets, domain rules and consents beneath it are
  // this browser's alone — the group is simply absent where there is no Host,
  // the same way a group with nothing in it is absent (ADR 0090).
  const hostConfigured = useHostConfigured();
  // And the Sites group is the Identity API's. Asked with none configured, it
  // answered "that client no longer exists on the Identity plane" — a 404
  // dressed as a revocation, about a plane that was never there.
  const identityConfigured = useIdentityConfigured();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clients, setClients] = useState<OAuthClient[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [view, setView] = useState<ResourcesView>({ kind: "list" });
  const [flash, setFlash] = useState<Flash | null>(null);
  const [query, setQuery] = useState("");
  const run = useRef(0);
  const clientsRun = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    try {
      const rows = await listConnections();
      if (run.current !== id) return;
      setConnections(rows);
      setLoadError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setConnections(null);
      setLoadError(accessErrorText(caught));
    }
  }, []);

  const loadClients = useCallback(async () => {
    const id = ++clientsRun.current;
    try {
      const data = await callIdentity<{ clients: OAuthClient[] }>(
        "/v1/oauth/clients",
      );
      if (clientsRun.current !== id) return;
      setClients(data.clients);
      setClientsError(null);
    } catch (caught) {
      if (clientsRun.current !== id) return;
      setClients(null);
      setClientsError(accessErrorText(caught));
    }
  }, []);

  useEffect(() => {
    if (hostConfigured) void load();
    if (identityConfigured) void loadClients();
  }, [hostConfigured, identityConfigured, load, loadClients]);

  const secrets = useMemo(
    () =>
      vault.status === "unlocked"
        ? vault.items
            .filter(isSecret)
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [vault.items, vault.status],
  );

  const needle = query.trim().toLowerCase();
  const shownConnections = (connections ?? []).filter(
    (connection) => !needle || connectionMatches(connection, needle),
  );
  const shownSecrets = secrets.filter(
    (item) => !needle || secretMatches(item, needle),
  );
  const shownSites = (clients ?? []).filter(
    (client) => !needle || siteMatches(client, needle),
  );
  // A plane nobody configured contributes no rows and is not pending: without
  // this, a deployment with neither never reached its own empty state.
  const nothingShown =
    (!hostConfigured || connections !== null) &&
    (!identityConfigured || clients !== null) &&
    shownConnections.length === 0 &&
    shownSecrets.length === 0 &&
    shownSites.length === 0;

  if (view.kind === "register") {
    return (
      <RegisterSiteCeremony
        online={online}
        onCancel={() => setView({ kind: "list" })}
        onRegistered={(client) => {
          setFlash({
            tone: "ok",
            text: `${client.displayName} is registered as ${client.id}.`,
          });
          setView({ kind: "site", client });
          void loadClients();
        }}
      />
    );
  }

  if (view.kind === "site") {
    return (
      <SiteDrillIn
        client={view.client}
        online={online}
        flash={flash}
        onFlash={setFlash}
        onBack={() => {
          setFlash(null);
          setView({ kind: "list" });
        }}
        onRotated={(next) => {
          setView({ kind: "site", client: next });
          void loadClients();
        }}
        onRevoked={() => {
          setView({ kind: "list" });
          void loadClients();
        }}
      />
    );
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Resources</h2>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            void load();
            void loadClients();
          }}
          disabled={!online}
          title="Reload resources"
          aria-label="Reload resources"
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
            placeholder="Name or reference…"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {loadError ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {loadError}
          </p>
        ) : null}

        {hostConfigured && connections === null && !loadError ? (
          <output className="note">Asking the Host…</output>
        ) : null}

        {shownConnections.length > 0 ? (
          <>
            <h3 className="access-group__label">Connections</h3>
            <ul className="access-resources">
              {shownConnections.map((connection) => (
                <ConnectionResourceRow
                  key={connection.connectionId}
                  connection={connection}
                  online={online}
                  onGrant={() => onGrant({ kind: "connection", connection })}
                  onPolicy={() => onPolicy(connection.connectionId)}
                />
              ))}
            </ul>
          </>
        ) : null}

        {shownSecrets.length > 0 ? (
          <>
            <h3 className="access-group__label">Secrets</h3>
            <ul className="access-resources">
              {shownSecrets.map((item) => (
                <li className="access-resource" key={item.id}>
                  <div className="access-resource__main">
                    <div className="access-resource__id">
                      <h3>{item.name}</h3>
                      <code className="access-ref">
                        {item.connectionRef.trim() || "—"}
                      </code>
                    </div>
                    <span className="access-resource__meta">
                      ceiling: {item.ceiling.length}
                    </span>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={!online}
                        onClick={() =>
                          onGrant({ kind: "secret", secret: item })
                        }
                      >
                        Grant access
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {!identityConfigured ? null : (
          <div className="access-group__head">
            <h3 className="access-group__label">Sites</h3>
            <button
              type="button"
              className="btn btn--sm"
              disabled={!online}
              onClick={() => {
                setFlash(null);
                setView({ kind: "register" });
              }}
            >
              <IconPlus /> Register a site
            </button>
          </div>
        )}

        {clientsError ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {clientsError}{" "}
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void loadClients()}
            >
              Retry
            </button>
          </p>
        ) : null}

        {identityConfigured && clients === null && !clientsError ? (
          <output className="note">Asking Identity…</output>
        ) : null}

        {identityConfigured &&
        clients !== null &&
        shownSites.length === 0 &&
        !needle ? (
          <p className="hint">No sites registered.</p>
        ) : null}

        {shownSites.length > 0 ? (
          <ul className="access-resources">
            {shownSites.map((client) => (
              <li className="access-resource" key={client.id}>
                <div className="access-resource__main">
                  <div className="access-resource__id">
                    <h3>{client.displayName}</h3>
                    <code className="access-ref">{siteOriginOf(client)}</code>
                  </div>
                  <span className={`chip ${siteStateChip(client.state)}`}>
                    {client.state}
                  </span>
                  <span className="access-resource__meta">
                    <time dateTime={client.createdAt}>
                      {formatTime(client.createdAt)}
                    </time>
                  </span>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => {
                        setFlash(null);
                        setView({ kind: "site", client });
                      }}
                    >
                      Manage
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {nothingShown ? (
          <p className="hint">
            {needle
              ? "Nothing matches."
              : "Nothing to grant yet — connect a service or add a secret."}{" "}
            {needle ? null : <Link to="/connections">Connections</Link>}
          </p>
        ) : null}

        {flash ? (
          <output className={`note note--${flash.tone} access-flash`}>
            {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
            <p>{flash.text}</p>
          </output>
        ) : null}
      </div>
    </section>
  );
}

function ConnectionResourceRow({
  connection,
  online,
  onGrant,
  onPolicy,
}: {
  connection: Connection;
  online: boolean;
  onGrant: () => void;
  onPolicy: () => void;
}) {
  const chip = STATUS_CHIP[connection.status];
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
        <div className="actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={!online}
            onClick={onGrant}
          >
            Grant access
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onPolicy}
          >
            Policy
          </button>
        </div>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------ site drill-in */

const SNIPPET_TABS = [
  { id: "signin", label: "Sign-in" },
  { id: "callback", label: "Callback page" },
  { id: "declarative", label: "Declarative" },
  { id: "explicit", label: "Explicit JS" },
] as const;

type SnippetTab = (typeof SNIPPET_TABS)[number]["id"];

function SiteDrillIn({
  client,
  online,
  flash,
  onFlash,
  onBack,
  onRotated,
  onRevoked,
}: {
  client: OAuthClient;
  online: boolean;
  flash: Flash | null;
  onFlash: (flash: Flash | null) => void;
  onBack: () => void;
  onRotated: (next: OAuthClient) => void;
  onRevoked: () => void;
}) {
  const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);
  const [busy, setBusy] = useState(false);
  const { copy, copied } = useCopy();

  async function run(action: "rotate" | "revoke") {
    setBusy(true);
    try {
      if (action === "rotate") {
        const next = await callIdentity<OAuthClient>(
          `/v1/oauth/clients/${encodeURIComponent(client.id)}/rotate`,
          { method: "POST" },
        );
        onFlash({
          tone: "ok",
          text: `${client.displayName} now uses client id ${next.id}. The previous id ${client.id} is revoked — paste the updated snippet into the site before its next sign-in.`,
        });
        onRotated(next);
      } else {
        await callIdentity<OAuthClient>(
          `/v1/oauth/clients/${encodeURIComponent(client.id)}/revoke`,
          { method: "POST" },
        );
        onFlash({
          tone: "warn",
          text: `${client.displayName} is revoked. No new sign-in through ${client.id} will succeed; restoring the site means registering the origin again.`,
        });
        onRevoked();
      }
    } catch (caught) {
      onFlash({ tone: "err", text: accessErrorText(caught) });
      setBusy(false);
      // A 404 means the client is already gone — the row is stale.
      if (caught instanceof SitesError && caught.status === 404) onRevoked();
    } finally {
      setConfirm(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>{client.displayName}</h2>
        </div>
        <span className={`chip ${siteStateChip(client.state)}`}>
          {client.state}
        </span>
      </div>

      <div className="panel__body">
        <p>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onBack}
          >
            ← Resources
          </button>
        </p>

        <h3 className="access-group__label">Client id</h3>
        <div className="access-copyrow">
          <code className="access-ref">{client.id}</code>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void copy(client.id, "client-id")}
            title="Copy client id"
            aria-label="Copy client id"
          >
            {copied === "client-id" ? <IconCheck /> : <IconCopy />}
          </button>
        </div>

        <h3 className="access-group__label">Credential</h3>
        {confirm ? (
          <div className="access-confirm">
            <p>
              {confirm === "rotate" ? (
                <>
                  <strong>
                    Rotating issues a new client id and revokes {client.id} in
                    the same step.
                  </strong>{" "}
                  Pages still sending the old id are rejected until the new
                  snippet is in place.
                </>
              ) : (
                <>
                  <strong>
                    Revoking ends sign-in through {client.displayName}{" "}
                    immediately.
                  </strong>{" "}
                  This cannot be undone — restoring the site means registering
                  the origin again.
                </>
              )}
            </p>
            <div className="actions">
              <button
                type="button"
                className={
                  confirm === "revoke"
                    ? "btn btn--sm btn--danger"
                    : "btn btn--sm btn--primary"
                }
                disabled={busy || !online}
                onClick={() => void run(confirm)}
              >
                {busy
                  ? confirm === "rotate"
                    ? "Rotating…"
                    : "Revoking…"
                  : confirm === "rotate"
                    ? "Rotate and revoke old id"
                    : "Revoke this client"}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy || !online || client.state === "revoked"}
              onClick={() => setConfirm("rotate")}
            >
              <IconRefresh /> Rotate
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={busy || !online || client.state === "revoked"}
              onClick={() => setConfirm("revoke")}
            >
              <IconTrash /> Revoke
            </button>
          </div>
        )}

        <h3 className="access-group__label">Integration</h3>
        <SiteSnippet client={client} />

        <h3 className="access-group__label">Domain access</h3>
        <SiteDomainPolicy origin={siteOriginOf(client)} onFlash={onFlash} />

        <h3 className="access-group__label">Consents</h3>
        <SiteConsents origin={siteOriginOf(client)} onFlash={onFlash} />

        <h3 className="access-group__label">Sign-in events</h3>
        <SiteEvents clientId={client.id} online={online} />

        {flash ? (
          <output className={`note note--${flash.tone} access-flash`}>
            {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
            <p>{flash.text}</p>
          </output>
        ) : null}
      </div>
    </section>
  );
}

function SiteSnippet({ client }: { client: OAuthClient }) {
  const panelId = useId();
  const [tab, setTab] = useState<SnippetTab>("signin");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const code = useMemo(() => {
    const redirectUri = client.redirectUris[0] ?? "";
    if (tab === "callback") return buildCallbackSnippet({ redirectUri });
    if (tab === "signin") {
      return buildSignInSnippet({
        issuer: identityBase(),
        clientId: client.id,
        redirectUri,
        scopes: client.allowedScopes,
      });
    }
    const brokerBase = pagesPublicBase();
    const siteOrigin = siteOriginOf(client);
    return tab === "explicit"
      ? staticSiteExplicitSnippet({ brokerBase, siteOrigin })
      : staticSiteSnippet({ brokerBase, siteOrigin });
  }, [client, tab]);

  async function copy() {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(
        "The browser refused clipboard access here. Select the code and copy it with the keyboard instead.",
      );
    }
  }

  return (
    <div>
      <div className="access-snippet-bar">
        <div
          className="access-subtabs"
          role="tablist"
          aria-label="Integration snippet"
        >
          {SNIPPET_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              aria-controls={panelId}
              className={
                tab === entry.id ? "access-subtab is-on" : "access-subtab"
              }
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn--sm access-snippet-copy"
          onClick={() => void copy()}
        >
          {copied ? <IconCheck /> : <IconCopy />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        className="access-snippet"
        id={panelId}
        role="tabpanel"
        aria-label={
          SNIPPET_TABS.find((entry) => entry.id === tab)?.label ?? "Snippet"
        }
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the snippet scrolls, and a scrollable region must be reachable by keyboard
        tabIndex={0}
      >
        <code>{code}</code>
      </pre>
      {copyError ? (
        <p className="note note--err" role="alert">
          <IconAlert /> {copyError}
        </p>
      ) : null}
    </div>
  );
}

function SiteDomainPolicy({
  origin,
  onFlash,
}: {
  origin: string;
  onFlash: (flash: Flash) => void;
}) {
  const [policy, setPolicy] = useState<BrokerPolicy>(() => loadBrokerPolicy());
  const [domainDraft, setDomainDraft] = useState("");

  const restricted = isBrokerRestricted(policy);
  const allowed = policy.rules.filter((rule) => rule.effect === "whitelist");
  const blocked = policy.rules.filter((rule) => rule.effect === "blacklist");

  function addDomainEntry(raw: string, effect: DomainEffect) {
    const result = addDomainRule(raw, effect);
    if ("error" in result) {
      onFlash({ tone: "err", text: result.error });
      return;
    }
    setPolicy(result);
    setDomainDraft("");
    const becameRestricted =
      effect === "whitelist" && !isBrokerRestricted(policy);
    onFlash({
      tone: "ok",
      text:
        effect === "whitelist"
          ? becameRestricted
            ? `Allowed ${raw.trim()}. The broker is now restricted to allowed domains.`
            : `Allowed ${raw.trim()}.`
          : `Blocked ${raw.trim()}.`,
    });
  }

  return (
    <div className="access-policy-block">
      <div className="access-policy-head">
        <h4 className="access-policy-title">Broker policy</h4>
        <span
          className={
            restricted
              ? "access-policy-badge access-policy-badge--restricted"
              : "access-policy-badge access-policy-badge--public"
          }
        >
          {restricted ? "Restricted" : "Public"}
        </span>
      </div>

      <form
        className="access-domain-add"
        onSubmit={(event) => {
          event.preventDefault();
          addDomainEntry(domainDraft, restricted ? "whitelist" : "blacklist");
        }}
      >
        <label className="field" style={{ flex: 1, margin: 0 }}>
          <span className="field__label">Domain</span>
          <input
            type="text"
            className="input"
            placeholder="example.com, localhost:5173, or https://app.example.com"
            value={domainDraft}
            onChange={(event) => setDomainDraft(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {restricted ? (
          <>
            <button type="submit" className="btn btn--sm btn--primary">
              <IconPlus /> Allow
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => addDomainEntry(domainDraft, "blacklist")}
            >
              Block
            </button>
          </>
        ) : (
          <>
            <button type="submit" className="btn btn--sm">
              <IconPlus /> Block
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => addDomainEntry(domainDraft, "whitelist")}
            >
              Restrict to…
            </button>
          </>
        )}
      </form>

      {origin ? (
        <div className="actions" style={{ marginTop: "0.5rem" }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => addDomainEntry(origin, "whitelist")}
          >
            <IconPlus />{" "}
            {restricted
              ? "Allow this origin"
              : "Restrict broker to this origin"}
          </button>
        </div>
      ) : null}

      {restricted && allowed.length > 0 ? (
        <div className="access-domain-group">
          <h5 className="access-domain-group__title">Allowed</h5>
          <ul className="access-domain-list">
            {allowed.map((rule) => (
              <li key={rule.domain} className="access-domain-row">
                <code>{rule.domain}</code>
                <div className="access-domain-row__actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() =>
                      setPolicy(setDomainRuleEffect(rule.domain, "blacklist"))
                    }
                  >
                    Move to blocked
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    aria-label={`Remove ${rule.domain}`}
                    title={`Remove ${rule.domain}`}
                    onClick={() => {
                      const next = removeDomainRule(rule.domain);
                      setPolicy(next);
                      onFlash({
                        tone: "ok",
                        text: isBrokerRestricted(next)
                          ? `Removed ${rule.domain}.`
                          : `Removed ${rule.domain}. The broker is public again.`,
                      });
                    }}
                  >
                    <IconTrash />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {blocked.length > 0 ? (
        <div className="access-domain-group">
          <h5 className="access-domain-group__title">Blocked</h5>
          <ul className="access-domain-list">
            {blocked.map((rule) => (
              <li key={rule.domain} className="access-domain-row">
                <code>{rule.domain}</code>
                <div className="access-domain-row__actions">
                  {restricted ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() =>
                        setPolicy(setDomainRuleEffect(rule.domain, "whitelist"))
                      }
                    >
                      Move to allowed
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    aria-label={`Remove ${rule.domain}`}
                    title={`Remove ${rule.domain}`}
                    onClick={() => {
                      setPolicy(removeDomainRule(rule.domain));
                      onFlash({
                        tone: "ok",
                        text: `Unblocked ${rule.domain}.`,
                      });
                    }}
                  >
                    <IconTrash />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {restricted ? (
        <p className="note note--warn" style={{ marginTop: "0.75rem" }}>
          <IconAlert /> Restricted — unlisted domains cannot use the broker.
        </p>
      ) : null}
    </div>
  );
}

function SiteConsents({
  origin,
  onFlash,
}: {
  origin: string;
  onFlash: (flash: Flash) => void;
}) {
  const [consents, setConsents] = useState<SiteConsent[]>(() => loadConsents());
  const alreadyApproved =
    origin !== "" && consents.some((consent) => consent.origin === origin);

  return (
    <div>
      {origin ? (
        <div className="actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={alreadyApproved}
            onClick={() => {
              approveConsent(origin, "openid");
              setConsents(loadConsents());
              onFlash({
                tone: "ok",
                text: `Remembered consent for ${origin}.`,
              });
            }}
          >
            {alreadyApproved ? "Consent remembered" : "Remember consent"}
          </button>
        </div>
      ) : null}

      {consents.length === 0 ? (
        <p className="hint">No site origins approved yet.</p>
      ) : (
        <ul className="access-resources" style={{ marginTop: "0.75rem" }}>
          {consents.map((consent) => (
            <li className="access-resource" key={consent.origin}>
              <div className="access-resource__main">
                <div className="access-resource__id">
                  <h3>{consent.origin}</h3>
                  <code className="access-ref">
                    {consent.scopes.join(" ") || "openid"}
                  </code>
                </div>
                <span className="access-resource__meta">
                  {formatTime(consent.approvedAt)}
                </span>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => {
                      revokeConsent(consent.origin);
                      setConsents(loadConsents());
                      onFlash({
                        tone: "ok",
                        text: `Revoked broker consent for ${consent.origin}.`,
                      });
                    }}
                  >
                    <IconTrash /> Revoke
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SiteEvents({
  clientId,
  online,
}: {
  clientId: string;
  online: boolean;
}) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    try {
      const data = await callIdentity<{ events: AuditEvent[] }>(
        "/v1/audit/events?limit=50",
      );
      if (run.current !== id) return;
      // The audit API filters by event type, not by client — narrow to this
      // site's events here instead.
      setEvents(data.events.filter((event) => event.clientId === clientId));
      setError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setEvents(null);
      setError(accessErrorText(caught));
    }
  }, [clientId]);

  useEffect(() => {
    if (!online) return;
    void load();
  }, [load, online]);

  if (error) {
    return (
      <p className="note note--err" role="alert">
        <IconAlert /> {error}{" "}
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => void load()}
        >
          Retry
        </button>
      </p>
    );
  }
  if (events === null) {
    return <output className="note">Asking Identity…</output>;
  }
  if (events.length === 0) {
    return <p className="hint">No sign-in events for this site.</p>;
  }
  return (
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
  );
}

/* ---------------------------------------------------- ceremony: register a site */

/** Scopes this form can request. `openid` is mandatory for an OIDC client. */
const SCOPE_CHOICES = [
  {
    value: "openid",
    hint: "Required. Issues an ID token for the signed-in principal.",
  },
  {
    value: "profile",
    hint: "Display name and profile claims on the ID token.",
  },
  {
    value: "email",
    hint: "Email claim, when the principal has a verified email identity.",
  },
  {
    value: "offline_access",
    hint: "Refresh token, so the site can stay signed in.",
  },
];

const GRANT_TYPES = ["authorization_code", "refresh_token"];
const RESPONSE_TYPES = ["code"];
const TOKEN_AUTH_METHOD = "none";

function RegisterSiteCeremony({
  online,
  onCancel,
  onRegistered,
}: {
  online: boolean;
  onCancel: () => void;
  onRegistered: (client: OAuthClient) => void;
}) {
  const fieldId = useId();
  const [originInput, setOriginInput] = useState("");
  const [originTouched, setOriginTouched] = useState(false);
  const [callbackPath, setCallbackPath] = useState("/callback");
  const [nameInput, setNameInput] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [sectorInput, setSectorInput] = useState("");
  const [sectorTouched, setSectorTouched] = useState(false);
  const [scopes, setScopes] = useState<string[]>(["openid", "profile"]);
  const [submitting, setSubmitting] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const check = useMemo(() => checkOrigin(originInput), [originInput]);
  const origin = check.ok ? check.origin : null;
  const redirectUri = origin ? `${origin}${normalisePath(callbackPath)}` : null;
  const displayName = nameTouched ? nameInput : check.ok ? check.host : "";
  const sectorIdentifier = sectorTouched ? sectorInput : (origin ?? "");

  function toggleScope(value: string) {
    setScopes((current) =>
      current.includes(value)
        ? current.filter((scope) => scope !== value)
        : [...current, value],
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setOriginTouched(true);
    setFormError(null);
    setBlocked(null);
    if (!check.ok || !origin || !redirectUri) {
      setFormError(check.ok ? "Enter an origin first." : check.message);
      return;
    }
    if (!displayName.trim()) {
      setFormError(
        "Give the site a display name — it is what a person sees on the consent screen.",
      );
      return;
    }
    if (!sectorIdentifier.trim()) {
      setFormError(
        "The sector identifier cannot be empty; it groups redirect URIs that share one subject.",
      );
      return;
    }
    setSubmitting(true);
    try {
      const client = await callIdentity<OAuthClient>("/v1/oauth/clients", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          displayName: displayName.trim(),
          redirectUris: [redirectUri],
          sectorIdentifier: sectorIdentifier.trim(),
          grantTypes: GRANT_TYPES,
          responseTypes: RESPONSE_TYPES,
          tokenEndpointAuthMethod: TOKEN_AUTH_METHOD,
          allowedScopes: scopes,
          allowedResources: [],
          admissionMode: "pre_registered",
        }),
      });
      onRegistered(client);
    } catch (caught) {
      if (caught instanceof SitesError && caught.code === "assurance_too_low") {
        setBlocked(
          "A provisional session cannot register a client. Link a real identity on the Identity plane first, then come back and this form will submit unchanged.",
        );
      } else {
        setFormError(accessErrorText(caught));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Register a site</h2>
        </div>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>

      <div className="panel__body">
        <form className="access-register" onSubmit={submit} noValidate>
          <div className="access-register__fields">
            <div className="field">
              <label className="label" htmlFor={`${fieldId}-origin`}>
                Site origin
              </label>
              <input
                id={`${fieldId}-origin`}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://example.com"
                value={originInput}
                onChange={(event) => setOriginInput(event.target.value)}
                onBlur={() => setOriginTouched(true)}
                aria-invalid={originTouched && !check.ok ? true : undefined}
              />
              <p className="hint">
                Scheme and host only. https, except{" "}
                <code>http://localhost</code> and <code>http://127.0.0.1</code>.
              </p>
              {originTouched && !check.ok && originInput.trim() ? (
                <p className="note note--err">
                  <IconAlert /> {check.message}
                </p>
              ) : null}
            </div>

            <div className="field">
              <label className="label" htmlFor={`${fieldId}-path`}>
                Callback path
              </label>
              <input
                id={`${fieldId}-path`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={callbackPath}
                onChange={(event) => setCallbackPath(event.target.value)}
              />
              <p className="hint">
                The page that calls <code>handleRedirectCallback()</code>.
              </p>
            </div>

            <div className="field">
              <label className="label" htmlFor={`${fieldId}-name`}>
                Display name
              </label>
              <input
                id={`${fieldId}-name`}
                type="text"
                autoComplete="off"
                value={displayName}
                onChange={(event) => {
                  setNameTouched(true);
                  setNameInput(event.target.value);
                }}
                maxLength={128}
              />
              <p className="hint">Defaults to the host.</p>
            </div>

            <div className="field">
              <label className="label" htmlFor={`${fieldId}-sector`}>
                Sector identifier
              </label>
              <input
                id={`${fieldId}-sector`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={sectorIdentifier}
                onChange={(event) => {
                  setSectorTouched(true);
                  setSectorInput(event.target.value);
                }}
              />
              <p className="hint">Keep the origin for one site.</p>
            </div>

            <fieldset className="field access-scopes">
              <legend className="label">Scopes</legend>
              {SCOPE_CHOICES.map((scope) => (
                <label className="check" key={scope.value}>
                  <input
                    type="checkbox"
                    checked={
                      scope.value === "openid"
                        ? true
                        : scopes.includes(scope.value)
                    }
                    disabled={scope.value === "openid"}
                    onChange={() => toggleScope(scope.value)}
                  />
                  <span>
                    <code>{scope.value}</code>
                    <span className="hint">{scope.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>

          <aside
            className="access-derived"
            aria-label="Values that will be sent"
          >
            <h3>What gets registered</h3>
            <dl className="kv">
              <div>
                <dt>Redirect URI</dt>
                <dd>{redirectUri ?? "Waiting on a valid origin"}</dd>
              </div>
              <div>
                <dt>Sector identifier</dt>
                <dd>{sectorIdentifier || "Waiting on a valid origin"}</dd>
              </div>
              <div>
                <dt>Grant types</dt>
                <dd>{GRANT_TYPES.join(", ")}</dd>
              </div>
              <div>
                <dt>Response types</dt>
                <dd>{RESPONSE_TYPES.join(", ")}</dd>
              </div>
              <div>
                <dt>Token endpoint auth</dt>
                <dd>none — public client, PKCE S256</dd>
              </div>
              <div>
                <dt>Admission mode</dt>
                <dd>pre_registered</dd>
              </div>
            </dl>
          </aside>

          <div className="access-register__submit">
            {blocked ? (
              <p className="note note--warn" role="alert">
                <IconAlert /> {blocked}
              </p>
            ) : null}
            {formError ? (
              <p className="note note--err" role="alert">
                <IconAlert /> {formError}
              </p>
            ) : null}
            {online ? null : (
              <p className="note note--warn">
                <IconAlert /> Offline — registration needs a reachable Identity
                plane.
              </p>
            )}
            <div className="actions">
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={onCancel}
              >
                ← Resources
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={submitting || !online}
              >
                <IconPlus /> {submitting ? "Registering…" : "Register client"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- policies */

function PoliciesPanel({
  online,
  focusId,
  onFocusUsed,
}: {
  online: boolean;
  focusId: string | null;
  onFocusUsed: () => void;
}) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(focusId);
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

  useEffect(() => {
    if (focusId === null) return;
    setSelectedId(focusId);
    onFocusUsed();
  }, [focusId, onFocusUsed]);

  const live = (connections ?? []).filter(
    (connection) => connection.status !== "revoked",
  );
  const selected =
    live.find((connection) => connection.connectionId === selectedId) ?? null;

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Policies</h2>
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
          <p className="hint">No connections yet.</p>
        ) : null}

        {selected ? (
          <>
            <p>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => setSelectedId(null)}
              >
                ← Policies
              </button>
            </p>
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
        ) : live.length > 0 ? (
          <ul className="access-resources">
            {live.map((connection) => (
              <li className="access-resource" key={connection.connectionId}>
                <div className="access-resource__main">
                  <div className="access-resource__id">
                    <h3>{connection.displayName}</h3>
                    <code className="access-ref">
                      {connection.connectionRef}
                    </code>
                  </div>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => setSelectedId(connection.connectionId)}
                    >
                      Policy
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
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

/* ----------------------------------------------------------------- helpers */

/** Ticks so expiry countdowns move without a refetch. */
function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(timer);
  }, [stepMs]);
  return now;
}

function countdown(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 0) return "expired";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  if (seconds < 60) return rtf.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(hours, "hour");
  return rtf.format(Math.round(hours / 24), "day");
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
