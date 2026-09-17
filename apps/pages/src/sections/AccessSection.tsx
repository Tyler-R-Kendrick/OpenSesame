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
import { EmptyTip, emptyTips } from "../components/EmptyTip.js";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconCopy,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "../components/Icons.js";
import {
  AccessError,
  type Delegation,
  type DelegationOffer,
  type MintedOffer,
  type NarrowInput,
  type RelayRequest,
  approveRelayRequest,
  denyRelayRequest,
  listDelegations,
  listMyOffers,
  listRelayRequests,
  mintOffer,
  narrowDelegation,
  revokeDelegation,
  revokeOffer,
} from "../lib/access.js";
import {
  type BindingTargetKind,
  type Connection,
  bindConnection,
  listConnections,
} from "../lib/connections.js";
import {
  HostSessionError,
  IdentityError,
  identityBase,
  identityFetch,
  identityJson,
  useIdentitySession,
} from "../lib/identity.js";
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
import { useVault, useVaultStore } from "../lib/vault/hooks.js";
import type { SecretItem, VaultItem } from "../lib/vault/model.js";
import { GuideTarget } from "../tutorial/registry/react.jsx";
import { AccessAuthority } from "./access/AccessAuthority.js";
import { ApprovalInbox } from "./access/ApprovalInbox.js";
import { ClaimAccessCeremony } from "./access/ClaimAccessCeremony.js";
import { LocalAuthorityPanel } from "./access/LocalAuthorityPanel.js";
import { LocalPoliciesPanel } from "./access/LocalPoliciesPanel.js";
import { LocalSharePanel } from "./access/LocalSharePanel.js";
import { SessionsPanel } from "./access/SessionsPanel.js";
import { formatTime } from "./access/format.js";
import { type AuditEvent, outcomeChip } from "./access/receipts.js";
import { BindingEditor } from "./connections/BindingEditor.js";
import { ConnectorMark } from "./connections/ConnectorMark.js";
import { PolicyEditor } from "./connections/PolicyEditor.js";
import { type Flash, STATUS_CHIP, errorText } from "./connections/shared.js";
import "./connections.css";
import "./access.css";
import {
  accessIsImportCeremony,
  accessIsNewCeremony,
  accessPath,
  accessViewFromLocation,
  grantCeremonyPath,
} from "../lib/access-routes.js";
import { AccessBookPanel } from "./access/AccessBookPanel.js";
import { AccessPathbar } from "./access/AccessPathbar.js";
import { ACCESS_TABS, AccessTabLink } from "./access/AccessTabs.js";
import { ConnectorsPanel } from "./access/ConnectorsPanel.js";
import { GrantCeremony } from "./access/GrantCeremony.js";
import {
  connectionMatches,
  secretMatches,
} from "./access/GrantCeremonySteps.js";
import { ImportAccessCeremony } from "./access/ImportAccessCeremony.js";
import { type GrantTarget, parseCsv } from "./access/grant-ceremony-types.js";

/**
 * Access — the grantor's PAM plane (ADR 0061). Five tabs, one mounted at a
 * time; every action is its own ceremony with a back-link out, never fields
 * appended to a long page. Every list fails soft and reloads on demand.
 */
export function AccessSection() {
  const online = useOnline();
  const tomb = useVaultStore().activeTomb();
  const location = useLocation();
  const navigate = useNavigate();
  const tab = accessViewFromLocation(location.pathname, location.search);
  const adding = accessIsNewCeremony(location.pathname);
  const importing = accessIsImportCeremony(location.pathname);
  const grantQuery = new URLSearchParams(location.search);
  const preselectConnection = grantQuery.get("connection");
  const preselectSecret = grantQuery.get("secret");
  const [policyFocus, setPolicyFocus] = useState<string | null>(null);
  const [bookEpoch, setBookEpoch] = useState(0);
  const [authorityRevision, setAuthorityRevision] = useState(0);

  const openGrant = useCallback(
    (target: GrantTarget | null) => {
      if (target === null) {
        navigate(grantCeremonyPath(null));
        return;
      }
      if (target.kind === "connection") {
        navigate(
          grantCeremonyPath({
            connectionId: target.connection.connectionId,
          }),
        );
        return;
      }
      navigate(grantCeremonyPath({ secretId: target.secret.id }));
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

  // Each view exposes local authority independently of optional Host controls.
  const hostConfigured = useHostConfigured();

  return (
    <div className="section__inner">
      <header className="section__head">
        <h1>Access</h1>
      </header>
      <AccessAuthority
        onChanged={() => setAuthorityRevision((value) => value + 1)}
      />

      <AccessPathbar pathname={location.pathname} tab={tab} />

      <nav className="access-tabs" role="tablist" aria-label="Access views">
        {ACCESS_TABS.map(({ id, label, guideId }) => (
          <AccessTabLink
            key={id}
            guideId={guideId}
            label={label}
            to={accessPath(id)}
            current={tab === id && !adding && !importing}
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
              setAuthorityRevision((value) => value + 1);
              navigate(accessPath("grants"));
            }}
          />
        </GuideTarget>
      ) : null}

      {!adding && !importing && tab === "grants" ? (
        <>
          <AccessBookPanel key={bookEpoch} epoch={bookEpoch} />
          <LocalAuthorityPanel key={tomb} tomb={tomb} grantsOnly />
          <LocalSharePanel key={`${tomb}-shares`} tomb={tomb} />
          {hostConfigured ? (
            <GrantsPanel
              key={authorityRevision}
              online={online}
              onGrantAccess={openGrant}
            />
          ) : null}
        </>
      ) : null}
      {!adding && !importing && tab === "requests" ? (
        <>
          <ApprovalInbox online={online} />
          {!hostConfigured ? null : (
            <GuideTarget id="access.relay">
              <RequestsPanel key={authorityRevision} online={online} />
            </GuideTarget>
          )}
        </>
      ) : null}
      {!adding && !importing && tab === "sessions" ? (
        <SessionsPanel key={authorityRevision} online={online} />
      ) : null}
      {!adding && !importing && tab === "connectors" ? (
        <ConnectorsPanel key={tomb} tomb={tomb} />
      ) : null}
      {!adding && !importing && tab === "resources" ? (
        <ResourcesPanel
          online={online}
          onGrant={openGrant}
          onPolicy={openPolicy}
        />
      ) : null}
      {!adding && !importing && tab === "policies" ? (
        <>
          <LocalPoliciesPanel />
          {hostConfigured ? (
            <PoliciesPanel
              key={authorityRevision}
              online={online}
              focusId={policyFocus}
              onFocusUsed={clearPolicyFocus}
            />
          ) : null}
        </>
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

/* ------------------------------------------------------------------ grants */

function GrantsPanel({
  online,
  onGrantAccess,
}: {
  online: boolean;
  onGrantAccess: (target: GrantTarget | null) => void;
}) {
  const [claiming, setClaiming] = useState(false);
  const [delegations, setDelegations] = useState<Delegation[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const run = useRef(0);
  const now = useNow(30_000);

  const load = useCallback(async () => {
    const id = ++run.current;
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
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  if (claiming)
    return (
      <ClaimAccessCeremony
        online={online}
        onDone={() => {
          setClaiming(false);
          void load();
        }}
      />
    );
  return (
    <section className="panel" id="host-grants">
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
          <button
            type="button"
            className="btn btn--primary"
            disabled={!online}
            onClick={() => onGrantAccess(null)}
          >
            Grant access
          </button>
          <button
            type="button"
            className="btn"
            disabled={!online}
            onClick={() => setClaiming(true)}
          >
            Claim access
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

        {delegations !== null && active.length === 0 ? (
          <p className="hint">No active grants.</p>
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
    <section className="panel" id="host-requests">
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
          <>
            <p className="hint">Nothing waiting for approval.</p>
            <EmptyTip>{emptyTips.navigate}</EmptyTip>
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
  // Local resources need neither service; only query explicitly configured planes.
  const hostConfigured = useHostConfigured();
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
    if (!hostConfigured) return;
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
  }, [hostConfigured]);

  const loadClients = useCallback(async () => {
    if (!identityConfigured) return;
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
  }, [identityConfigured]);

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
          <div className="access-group__head" id="resource-sites">
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
          <>
            <p className="hint">
              {needle
                ? "Nothing matches."
                : "Nothing to grant yet — connect a service or add a secret."}{" "}
              {needle ? null : <Link to="/connections">Connections</Link>}
            </p>
            <EmptyTip>{needle ? emptyTips.keymap : emptyTips.rail}</EmptyTip>
          </>
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
    <section className="panel" id="host-policies">
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
