import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link } from "react-router";
import { createOpenSesame } from "@opensesame/sdk-browser";
import type { ClaimPresentation, StorageLike } from "@opensesame/sdk-browser";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconNote,
  IconRefresh,
  IconShield,
  IconTerminal,
  IconUpload,
  IconX,
} from "../components/Icons.js";
import {
  adoptToken,
  clearSession,
  connectProvisional,
  hostBase,
  identityBase,
  identityFetch,
  identityJson,
  IdentityError,
  probeHost,
  probeIdentity,
  useIdentitySession,
  type IdentitySession,
  type Principal,
} from "../lib/identity.js";
import { useOnline } from "../lib/use-online.js";
import { dequeue, enqueue, loadQueue, type QueuedAction } from "../lib/queue.js";
import "./authority.css";

/* ------------------------------------------------------------------ */
/* Types the shared modules do not model                              */
/* ------------------------------------------------------------------ */

type Probe = "unknown" | "reachable" | "unreachable";

/** GET /v1/principals/identities — superset of the identities on /me. */
type IdentityDetail = {
  id: string;
  kind: string;
  issuer: string;
  subject: string;
  displayHint?: string;
  assurance: string;
  linkedAt: string;
};

/**
 * The control-plane returns more than the SDK's ClaimPresentation type
 * declares: `version` always, and `won` / `preserved` on completion.
 */
type ClaimView = ClaimPresentation & {
  version?: number;
  completedByPrincipalId?: string;
  won?: boolean;
  preserved?: { principalId?: string; projectId?: string; agentId?: string };
};

type TabId = "session" | "device" | "claim" | "protocol";

const TABS: Array<{ id: TabId; label: string; Icon: typeof IconShield }> = [
  { id: "session", label: "Session", Icon: IconShield },
  { id: "device", label: "Authorize a device", Icon: IconTerminal },
  { id: "claim", label: "Claim ownership", Icon: IconClaimSeal },
  { id: "protocol", label: "Protocol", Icon: IconNote },
];

/** Not in Icons.tsx: a seal, for the ownership ceremony. */
function IconClaimSeal({
  className,
  title,
  size = 24,
}: {
  className?: string;
  title?: string;
  size?: number;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="9" r="6" />
      <path d="m9.5 9 1.8 1.8L15 7" />
      <path d="M8.5 14.3 7 22l5-2.4L17 22l-1.5-7.7" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* User codes — Crockford Base32, XXXX-XXXX                            */
/* ------------------------------------------------------------------ */

/** Matches CROCKFORD_ALPHABET in packages/os-domain/src/crypto/claim-token.ts. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Mirrors `normalizeUserCode` server-side: uppercase, drop separators,
 * fold the ambiguous glyphs Crockford excludes, then re-group as XXXX-XXXX.
 */
function formatUserCode(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/O/gu, "0")
    .replace(/[IL]/gu, "1")
    .split("")
    .filter((ch) => CROCKFORD.includes(ch))
    .join("")
    .slice(0, 8);
  return cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
}

const CLAIM_TOKEN_PREFIX = "osc_clm_";

function looksLikeClaimToken(token: string): boolean {
  return token.startsWith(CLAIM_TOKEN_PREFIX) && token.slice(CLAIM_TOKEN_PREFIX.length).includes(".");
}

/* ------------------------------------------------------------------ */
/* SDK wiring                                                          */
/* ------------------------------------------------------------------ */

/** Last non-ok response seen by the injected fetch, so errors can be explained. */
type TransportFailure = { status: number | null; code: string | null };

/**
 * `createOpenSesame` defaults its session store to sessionStorage and hardcodes
 * an `/api/v1` claim prefix; the control-plane mounts claims at `/v1`. Inject a
 * memory store seeded from the identity session and rewrite the path, so the
 * ceremony authenticates without any web storage being touched.
 */
function createClaimClient(session: IdentitySession | null) {
  const base = identityBase().replace(/\/+$/u, "");
  const memory = new Map<string, string>();
  if (session) {
    memory.set(
      "opensesame:session",
      JSON.stringify({
        accessToken: session.accessToken,
        anonymous: false,
        raw: { access_token: session.accessToken, token_type: "Bearer" },
      }),
    );
  }
  const storage: StorageLike = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
    removeItem: (key) => {
      memory.delete(key);
    },
  };

  const failure: TransportFailure = { status: null, code: null };

  const fetchImpl: typeof fetch = async (input, init) => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await fetch(href.replace("/api/v1/claims", "/v1/claims"), {
      ...init,
      credentials: "include",
    });
    if (!res.ok) {
      failure.status = res.status;
      failure.code = await readErrorCode(res.clone());
    }
    return res;
  };

  const client = createOpenSesame({ issuer: base, apiBase: base, storage, fetchImpl });
  return { client, failure };
}

async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown; hint?: unknown };
    if (typeof body.error === "string") return body.error;
    if (typeof body.message === "string") return body.message;
    if (typeof body.hint === "string") return body.hint;
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

export function AuthoritySection() {
  const session = useIdentitySession();
  const online = useOnline();
  const [tab, setTab] = useState<TabId>("session");
  const [queue, setQueue] = useState<QueuedAction[]>(() => loadQueue());

  const refreshQueue = useCallback(() => {
    setQueue(loadQueue());
  }, []);

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = TABS.length - 1;
    let target = -1;
    if (event.key === "ArrowRight") target = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") target = index === 0 ? last : index - 1;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = last;
    if (target < 0) return;
    event.preventDefault();
    const next = TABS[target];
    if (!next) return;
    setTab(next.id);
    tabRefs.current[target]?.focus();
  }

  return (
    <div className="section__inner">
      <header className="section__head">
        <h1>Authority</h1>
        <p>
          Prove who you are to the OpenSesame identity plane, authorize the devices and
          agents acting for you, take ownership of what they created, and read what the
          protocol actually guarantees.
        </p>
      </header>

      <PlaneStatus />

      {queue.length > 0 ? (
        <Outbox
          items={queue}
          online={online}
          session={session}
          onChange={refreshQueue}
        />
      ) : null}

      <div className="authority-tabs" role="tablist" aria-label="Authority areas">
        {TABS.map((entry, index) => {
          const selected = entry.id === tab;
          return (
            <button
              key={entry.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`authority-tab-${entry.id}`}
              aria-controls={`authority-panel-${entry.id}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={`authority-tab${selected ? " is-active" : ""}`}
              onClick={() => setTab(entry.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              <entry.Icon size={17} />
              <span>{entry.label}</span>
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`authority-panel-${tab}`}
        aria-labelledby={`authority-tab-${tab}`}
        tabIndex={0}
        className="authority-panelwrap"
      >
        {tab === "session" ? <SessionArea session={session} /> : null}
        {tab === "device" ? (
          <DeviceArea session={session} online={online} onQueue={refreshQueue} />
        ) : null}
        {tab === "claim" ? (
          <ClaimArea session={session} online={online} onQueue={refreshQueue} />
        ) : null}
        {tab === "protocol" ? <ProtocolArea /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reachability                                                        */
/* ------------------------------------------------------------------ */

function PlaneStatus() {
  const [identity, setIdentity] = useState<Probe>("unknown");
  const [host, setHost] = useState<Probe>("unknown");
  const [probing, setProbing] = useState(false);

  const run = useCallback(async () => {
    setProbing(true);
    const [nextIdentity, nextHost] = await Promise.all([probeIdentity(), probeHost()]);
    setIdentity(nextIdentity);
    setHost(nextHost);
    setProbing(false);
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Planes</h2>
          <p>Where this page sends every request in this section.</p>
        </div>
        <div className="actions actions--end">
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void run()}
            disabled={probing}
            aria-busy={probing}
          >
            <IconRefresh size={16} />
            {probing ? "Checking…" : "Re-check"}
          </button>
        </div>
      </div>
      <div className="panel__body">
        <div className="authority-planes">
          <PlaneCard name="Identity API" url={identityBase()} probe={identity} />
          <PlaneCard name="Host API" url={hostBase()} probe={host} />
        </div>
        <p className="hint">
          Both addresses come from your settings.{" "}
          <Link to="/settings">Change them in Settings</Link> if you run these services
          somewhere other than the loopback defaults.
        </p>
      </div>
    </section>
  );
}

function PlaneCard({ name, url, probe }: { name: string; url: string; probe: Probe }) {
  const dot =
    probe === "reachable" ? "dot dot--ok" : probe === "unreachable" ? "dot dot--warn" : "dot";
  const label =
    probe === "reachable"
      ? "Reachable"
      : probe === "unreachable"
        ? "Not answering"
        : "Checking…";
  return (
    <div className="authority-plane">
      <div className="authority-plane__name">
        <span className={dot} aria-hidden="true" />
        <span>{name}</span>
      </div>
      <p className="authority-plane__state">{label}</p>
      <p className="authority-plane__url">{url}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 1 — Session / principal                                             */
/* ------------------------------------------------------------------ */

function SessionArea({ session }: { session: IdentitySession | null }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [details, setDetails] = useState<IdentityDetail[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) {
      setPrincipal(null);
      setDetails([]);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const me = await identityJson<Principal>("/v1/principals/me");
      setPrincipal(me);
      try {
        const listed = await identityJson<{ identities: IdentityDetail[] }>(
          "/v1/principals/identities",
        );
        setDetails(listed.identities);
      } catch {
        // /me already carries the identity list; the detail view is a bonus.
        setDetails([]);
      }
    } catch (err) {
      setPrincipal(null);
      setDetails([]);
      setLoadError(describePrincipalError(err));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!session) {
    return <ConnectArea />;
  }

  return (
    <>
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Principal</h2>
            <p>The identity this tab is acting as.</p>
          </div>
          <div className="actions actions--end">
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => void load()}
              disabled={loading}
              aria-busy={loading}
            >
              <IconRefresh size={16} />
              {loading ? "Loading…" : "Reload"}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              onClick={() => {
                clearSession();
                setPrincipal(null);
                setDetails([]);
                setLoadError(null);
              }}
            >
              <IconX size={16} />
              Disconnect
            </button>
          </div>
        </div>
        <div className="panel__body">
          {loadError ? (
            <p className="note note--err" role="alert">
              <IconAlert size={18} />
              <span>{loadError}</span>
            </p>
          ) : null}

          {principal ? (
            <>
              <dl className="kv">
                <div>
                  <dt>Principal</dt>
                  <dd>
                    <CopyableId value={principal.id} />
                  </dd>
                </div>
                <div>
                  <dt>State</dt>
                  <dd>
                    <span
                      className={`chip ${principal.state === "active" ? "chip--ok" : "chip--warn"}`}
                    >
                      {principal.state}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Assurance</dt>
                  <dd>
                    <span
                      className={`chip ${
                        principal.assurance === "provisional" ? "chip--warn" : "chip--ok"
                      }`}
                    >
                      {principal.assurance}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatWhen(principal.createdAt)}</dd>
                </div>
                <div>
                  <dt>Version</dt>
                  <dd>{principal.version}</dd>
                </div>
                {principal.verifiedAt ? (
                  <div>
                    <dt>Verified</dt>
                    <dd>{formatWhen(principal.verifiedAt)}</dd>
                  </div>
                ) : null}
              </dl>

              {principal.assurance === "provisional" ? (
                <p className="note note--warn">
                  <IconAlert size={18} />
                  <span>
                    This is a provisional principal. It can approve devices and complete
                    claims, but the Identity API refuses OAuth client registration at this
                    assurance level (<code>403 assurance_too_low</code>). Link a real
                    identity with the <code>opensesame-id</code> CLI to raise it.
                  </span>
                </p>
              ) : null}

              <p className="hint">
                Session expires {formatWhen(session.expiresAt)}. The access token lives in
                this tab&rsquo;s memory only — it is never written to storage, so closing
                the tab ends the session.
              </p>
            </>
          ) : loading ? (
            <p className="hint">Reading the principal from the Identity API…</p>
          ) : null}
        </div>
      </section>

      {principal ? <IdentitiesPanel principal={principal} details={details} /> : null}
    </>
  );
}

function IdentitiesPanel({
  principal,
  details,
}: {
  principal: Principal;
  details: IdentityDetail[];
}) {
  const byId = new Map(details.map((entry) => [entry.id, entry]));

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Linked identities</h2>
          <p>
            Upstream accounts folded into this principal. Each one carries its own
            assurance; the principal takes the strongest.
          </p>
        </div>
      </div>
      {principal.identities.length === 0 ? (
        <div className="panel__body">
          <div className="empty">
            <div className="empty__mark">
              <IconShield size={22} />
            </div>
            <h3>No upstream identity linked</h3>
            <p>
              Nothing is federated into this principal yet. Linking one is an OAuth
              redirect the identity plane owns — run <code>opensesame-id link</code> from
              a terminal, or sign in through a provider on the Identity API.
            </p>
          </div>
        </div>
      ) : (
        <div className="panel__body panel__body--tight">
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Issuer</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Assurance</th>
                  <th scope="col">Linked</th>
                </tr>
              </thead>
              <tbody>
                {principal.identities.map((identity) => {
                  const detail = byId.get(identity.id);
                  return (
                    <tr key={identity.id}>
                      <td>
                        {identity.kind}
                        {identity.displayHint ? (
                          <span className="authority-hint-inline">
                            {identity.displayHint}
                          </span>
                        ) : null}
                      </td>
                      <td className="authority-wrap">{identity.issuer}</td>
                      <td className="authority-wrap">
                        {detail ? <code>{detail.subject}</code> : <span className="hint">—</span>}
                      </td>
                      <td>
                        <span className="chip">{identity.assurance}</span>
                      </td>
                      <td>{detail ? formatWhen(detail.linkedAt) : <span className="hint">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function ConnectArea() {
  const [busy, setBusy] = useState<"provisional" | "adopt" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");

  async function connect() {
    setBusy("provisional");
    setError(null);
    try {
      await connectProvisional();
    } catch (err) {
      setError(describeConnectError(err));
    } finally {
      setBusy(null);
    }
  }

  function adopt() {
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Paste the access token that the CLI printed.");
      return;
    }
    setBusy("adopt");
    setError(null);
    try {
      adoptToken(trimmed);
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not adopt that token.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Not connected</h2>
            <p>
              Nothing else in this section works until this tab is acting as a principal.
              Two ways in, both real.
            </p>
          </div>
        </div>
        <div className="panel__body">
          <div className="authority-onramps">
            <div className="authority-onramp">
              <h3>Start anonymously</h3>
              <p>
                Creates a provisional principal on the Identity API. You get an identity
                immediately with no account and no email.
              </p>
              <p className="note note--warn">
                <IconAlert size={18} />
                <span>
                  A provisional principal has reduced authority. It can approve devices
                  and complete claims, but it cannot register OAuth clients — the Identity
                  API answers <code>403 assurance_too_low</code>. Raise assurance later by
                  linking a real identity.
                </span>
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void connect()}
                  disabled={busy !== null}
                  aria-busy={busy === "provisional"}
                >
                  {busy === "provisional" ? "Connecting…" : "Create provisional principal"}
                </button>
              </div>
            </div>

            <div className="authority-onramp">
              <h3>Adopt a token you already have</h3>
              <p>
                If <code>opensesame-id</code> already signed you in on this machine, paste
                the access token it printed and this tab will act as that principal.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  adopt();
                }}
              >
                <div className="field">
                  <label className="label" htmlFor="authority-adopt-token">
                    Access token
                  </label>
                  <input
                    id="authority-adopt-token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste the token from your terminal"
                    value={token}
                    disabled={busy !== null}
                    onChange={(event) => setToken(event.target.value)}
                  />
                  <p className="hint">
                    Held in memory for this tab only. It is never written to storage, never
                    sent anywhere except the Identity API at {identityBase()}, and it is
                    gone when you close the tab.
                  </p>
                </div>
                <div className="actions">
                  <button
                    type="submit"
                    className="btn"
                    disabled={busy !== null || token.trim().length === 0}
                    aria-busy={busy === "adopt"}
                  >
                    Use this token
                  </button>
                </div>
              </form>
            </div>
          </div>

          {error ? (
            <p className="note note--err" role="alert">
              <IconAlert size={18} />
              <span>{error}</span>
            </p>
          ) : null}
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 2 — Authorize a device                                              */
/* ------------------------------------------------------------------ */

type Outcome = { tone: "ok" | "warn" | "err"; message: string } | null;

function DeviceArea({
  session,
  online,
  onQueue,
}: {
  session: IdentitySession | null;
  online: boolean;
  onQueue: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const complete = code.replace("-", "").length === 8;

  async function submit() {
    setOutcome(null);
    if (!code) {
      setOutcome({ tone: "err", message: "Enter the user code your terminal is showing." });
      return;
    }

    if (!online) {
      enqueue({ kind: "device_approve", userCode: code });
      onQueue();
      setCode("");
      setOutcome({
        tone: "warn",
        message: `Offline — ${code} is staged in the outbox above. Flush it when you are back online, before the code expires.`,
      });
      return;
    }

    if (!session) {
      setOutcome({
        tone: "err",
        message:
          "Your session cannot approve devices — connect a principal first, on the Session tab.",
      });
      return;
    }

    setBusy(true);
    try {
      const res = await identityFetch("/v1/device/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_code: code }),
      });
      if (!res.ok) {
        setOutcome({ tone: "err", message: await describeApproveFailure(res) });
        return;
      }
      setCode("");
      setOutcome({
        tone: "ok",
        message:
          "Device authorized. Return to the terminal — it is holding a short-lived client session now.",
      });
    } catch {
      setOutcome({ tone: "err", message: unreachableMessage() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Authorize a device</h2>
          <p>
            A device or CLI showed you an eight-character code. Typing it here tells the
            identity plane that the person at that terminal is you.
          </p>
        </div>
      </div>
      <div className="panel__body">
        <p className="note">
          <IconShield size={18} />
          <span>
            This grants a <strong>short-lived client session</strong> and nothing more. It
            does not transfer ownership of anything, and it does not give the device your
            credentials — for durable ownership, use the Claim ownership tab.
          </span>
        </p>

        {!online ? (
          <p className="note note--warn" role="status">
            <IconClock size={18} />
            <span>
              You are offline. Submitting will stage the code in the outbox instead of
              approving it now. User codes expire, so flush the outbox promptly.
            </span>
          </p>
        ) : !session ? (
          <p className="note note--warn" role="status">
            <IconAlert size={18} />
            <span>
              Approving needs a principal. Connect one on the <strong>Session</strong> tab
              first — the Identity API will reject an unauthenticated approval.
            </span>
          </p>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="field">
            <label className="label" htmlFor="authority-user-code">
              User code
            </label>
            <input
              id="authority-user-code"
              className="authority-code"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
              placeholder="XXXX-XXXX"
              aria-describedby="authority-user-code-hint"
              value={code}
              disabled={busy}
              onChange={(event) => setCode(formatUserCode(event.target.value))}
            />
            <p className="hint" id="authority-user-code-hint">
              Eight characters, Crockford Base32. Spaces and dashes are ignored, and the
              ambiguous glyphs are folded for you — type O and you get 0, type I or L and
              you get 1.
            </p>
          </div>
          <div className="actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !complete}
              aria-busy={busy}
            >
              {busy ? "Authorizing…" : online ? "Authorize device" : "Stage for later"}
            </button>
          </div>
        </form>

        {outcome ? (
          <p
            className={`note note--${outcome.tone}`}
            role={outcome.tone === "err" ? "alert" : "status"}
          >
            {outcome.tone === "ok" ? <IconCheck size={18} /> : <IconAlert size={18} />}
            <span>{outcome.message}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 3 — Claim ownership                                                 */
/* ------------------------------------------------------------------ */

function ClaimArea({
  session,
  online,
  onQueue,
}: {
  session: IdentitySession | null;
  online: boolean;
  onQueue: () => void;
}) {
  const [token, setToken] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [presented, setPresented] = useState<ClaimView | null>(null);
  const [completed, setCompleted] = useState<ClaimView | null>(null);
  const [busy, setBusy] = useState<"present" | "complete" | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  function reset() {
    setToken("");
    setPresented(null);
    setCompleted(null);
    setOutcome(null);
    setRevealed(false);
  }

  async function present() {
    setOutcome(null);
    const trimmed = token.trim();
    if (!trimmed) {
      setOutcome({ tone: "err", message: "Paste the claim token printed by the tool that created the claim." });
      return;
    }
    if (!looksLikeClaimToken(trimmed)) {
      setOutcome({
        tone: "err",
        message:
          "That is not a claim token. Claim tokens start with osc_clm_ and contain a dot — check you copied the whole line.",
      });
      return;
    }

    if (!online) {
      enqueue({ kind: "claim_complete", claimToken: trimmed });
      onQueue();
      reset();
      setOutcome({
        tone: "warn",
        message:
          "Offline — the claim is staged in the outbox above. Flushing it will present and complete in one go, accepting everything in the claim, because there is no way to show you the review step while disconnected.",
      });
      return;
    }

    setBusy("present");
    const { client, failure } = createClaimClient(session);
    try {
      setPresented((await client.presentClaim(trimmed)) as ClaimView);
    } catch {
      // Claim tokens are single-use, so the failure is read from the transport
      // holder rather than by replaying the request to learn its status.
      setOutcome({ tone: "err", message: describePresentFailure(failure) });
    } finally {
      setBusy(null);
    }
  }

  async function complete() {
    if (!presented) return;
    if (!session) {
      setOutcome({
        tone: "err",
        message:
          "Completing a claim attaches it to a principal, and this tab does not have one. Connect on the Session tab, then present the token again.",
      });
      return;
    }
    setOutcome(null);
    setBusy("complete");
    const { client, failure } = createClaimClient(session);
    try {
      setCompleted(
        (await client.completeClaim(presented.id, { acceptedItemIds: ["*"] })) as ClaimView,
      );
      setToken("");
    } catch (err) {
      setOutcome({ tone: "err", message: describeCompleteFailure(failure, err) });
    } finally {
      setBusy(null);
    }
  }

  const step = completed ? 3 : presented ? 2 : 1;

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Claim ownership</h2>
          <p>
            Attaches durable ownership of an agent, project, or connection to your
            principal. Unlike authorizing a device, this does not expire.
          </p>
        </div>
        {presented || completed ? (
          <div className="actions actions--end">
            <button type="button" className="btn btn--sm btn--ghost" onClick={reset}>
              Start over
            </button>
          </div>
        ) : null}
      </div>
      <div className="panel__body">
        {!online ? (
          <p className="note note--warn" role="status">
            <IconClock size={18} />
            <span>
              You are offline. A token submitted now is staged whole and completed later
              without a review step.
            </span>
          </p>
        ) : null}

        <ol className="authority-steps">
          <li className={`authority-step${step === 1 ? " is-current" : step > 1 ? " is-done" : ""}`}>
            <span className="authority-step__n" aria-hidden="true">
              {step > 1 ? <IconCheck size={15} /> : "1"}
            </span>
            <div className="authority-step__body">
              <h3>Present the token</h3>
              {step === 1 ? (
                <>
                  <p>
                    Presenting reads the claim without accepting it. Nothing changes
                    hands at this step.
                  </p>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void present();
                    }}
                  >
                    <div className="field">
                      <label className="label" htmlFor="authority-claim-token">
                        Claim token
                      </label>
                      <div className="authority-reveal">
                        <input
                          id="authority-claim-token"
                          type={revealed ? "text" : "password"}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="osc_clm_…"
                          value={token}
                          disabled={busy !== null}
                          onChange={(event) => setToken(event.target.value)}
                        />
                        <button
                          type="button"
                          className={`icon-btn${revealed ? " is-on" : ""}`}
                          onClick={() => setRevealed((value) => !value)}
                          aria-pressed={revealed}
                          aria-label={revealed ? "Hide claim token" : "Reveal claim token"}
                        >
                          {revealed ? <IconEyeOff size={17} /> : <IconEye size={17} />}
                        </button>
                      </div>
                      <p className="hint">
                        The token is a bearer credential for this one claim. It is masked
                        by default, held in memory, and not stored.
                      </p>
                    </div>
                    <div className="actions">
                      <button
                        type="submit"
                        className="btn btn--primary"
                        disabled={busy !== null || token.trim().length === 0}
                        aria-busy={busy === "present"}
                      >
                        {busy === "present"
                          ? "Presenting…"
                          : online
                            ? "Present claim"
                            : "Stage for later"}
                      </button>
                    </div>
                  </form>
                </>
              ) : (
                <p className="hint">Presented. The claim below is what the token unlocked.</p>
              )}
            </div>
          </li>

          <li className={`authority-step${step === 2 ? " is-current" : step > 2 ? " is-done" : ""}`}>
            <span className="authority-step__n" aria-hidden="true">
              {step > 2 ? <IconCheck size={15} /> : "2"}
            </span>
            <div className="authority-step__body">
              <h3>Review what you are taking</h3>
              {presented ? (
                <>
                  <dl className="kv">
                    <div>
                      <dt>Claim</dt>
                      <dd>
                        <CopyableId value={presented.id} />
                      </dd>
                    </div>
                    <div>
                      <dt>Type</dt>
                      <dd>
                        <span className="chip chip--accent">{presented.type}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>State</dt>
                      <dd>
                        <span className="chip">{presented.state}</span>
                      </dd>
                    </div>
                    <div>
                      <dt>Expires</dt>
                      <dd>{formatWhen(presented.expiresAt)}</dd>
                    </div>
                    {typeof presented.version === "number" ? (
                      <div>
                        <dt>Version</dt>
                        <dd>{presented.version}</dd>
                      </div>
                    ) : null}
                  </dl>

                  <div className="field">
                    <span className="label">Target manifest digest</span>
                    <p className="authority-digest">{presented.targetManifestDigest}</p>
                    <p className="hint">
                      This digest is the claim&rsquo;s subject. The manifest itself stays
                      server-side — the identity plane returns the digest, not its
                      contents, so this page cannot enumerate the individual items.
                      Compare it against the digest your tool printed when it created the
                      claim.
                    </p>
                  </div>

                  {presented.items && presented.items.length > 0 ? (
                    <div className="scroll-x">
                      <table className="table">
                        <thead>
                          <tr>
                            <th scope="col">Item</th>
                            <th scope="col">Id</th>
                          </tr>
                        </thead>
                        <tbody>
                          {presented.items.map((item) => (
                            <tr key={item.id}>
                              <td>{item.label}</td>
                              <td>
                                <code>{item.id}</code>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="note">
                      <IconShield size={18} />
                      <span>
                        Completing accepts the claim in full (<code>acceptedItemIds: ["*"]</code>).
                        Per-item selection is not offered because this deployment does not
                        return an item list to choose from. If the digest is not the one
                        you expect, stop here — presenting changed nothing.
                      </span>
                    </p>
                  )}

                  {step === 2 ? (
                    <div className="actions">
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() => void complete()}
                        disabled={busy !== null || !online}
                        aria-busy={busy === "complete"}
                      >
                        {busy === "complete" ? "Completing…" : "Accept and take ownership"}
                      </button>
                      <button type="button" className="btn btn--ghost" onClick={reset}>
                        Discard
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="hint">
                  Present a token first. This is where you check the claim&rsquo;s type and
                  digest before anything is accepted.
                </p>
              )}
            </div>
          </li>

          <li className={`authority-step${step === 3 ? " is-current is-done" : ""}`}>
            <span className="authority-step__n" aria-hidden="true">
              {step > 2 ? <IconCheck size={15} /> : "3"}
            </span>
            <div className="authority-step__body">
              <h3>Ownership attached</h3>
              {completed ? (
                <>
                  <p className="note note--ok" role="status">
                    <IconCheck size={18} />
                    <span>
                      Claim <code>{completed.id}</code> is {completed.state}.
                      {completed.won === false
                        ? " Another principal completed this claim first, so ownership did not move to you."
                        : " Ownership is attached to your principal."}
                    </span>
                  </p>
                  {completed.preserved ? (
                    <dl className="kv">
                      {completed.preserved.principalId ? (
                        <div>
                          <dt>Owner</dt>
                          <dd>
                            <CopyableId value={completed.preserved.principalId} />
                          </dd>
                        </div>
                      ) : null}
                      {completed.preserved.projectId ? (
                        <div>
                          <dt>Project</dt>
                          <dd>
                            <CopyableId value={completed.preserved.projectId} />
                          </dd>
                        </div>
                      ) : null}
                      {completed.preserved.agentId ? (
                        <div>
                          <dt>Agent</dt>
                          <dd>
                            <CopyableId value={completed.preserved.agentId} />
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}
                </>
              ) : (
                <p className="hint">
                  Nothing is accepted until you complete step 2. Completion is recorded in
                  your audit trail and cannot be undone from this page.
                </p>
              )}
            </div>
          </li>
        </ol>

        {outcome ? (
          <p
            className={`note note--${outcome.tone}`}
            role={outcome.tone === "err" ? "alert" : "status"}
          >
            <IconAlert size={18} />
            <span>{outcome.message}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 4 — Protocol truth                                                  */
/* ------------------------------------------------------------------ */

type Assertion = { id: string; claim: string; detail: string; source: string };

const ASSERTIONS: Assertion[] = [
  {
    id: "ceiling",
    claim: "The ceiling is immutable once a task activates.",
    detail:
      "A task run fixes its capability ceiling and a compiled ceiling digest at activation. Every later proposal is checked as a subset of that ceiling, so no step in a run can raise its own limit.",
    source: "crates/domain/src/task.rs",
  },
  {
    id: "ratchet",
    claim: "next \u2286 current \u2286 ceiling. Authority never widens.",
    detail:
      "Capability sets shrink monotonically. There is no widen operation in the domain model at all — reductions go through a capability state transition and need enforcement acknowledgements before they commit, so downstream enforcers observe the shrink before effects become irreversible.",
    source: "ADR 0020 \u2014 Trust ratchet",
  },
  {
    id: "mcp",
    claim: "MCP revision 2026-07-28 uses Authorization: Bearer \u2014 not DPoP.",
    detail:
      "The mcp-authorization-2026-07-28-bearer profile is marked Draft and is Bearer-only here: no task binding, no replay protection. There is no DPoP profile for MCP in this repository, and confusing the two is exactly the mistake the profile matrix exists to prevent.",
    source: "docs/protocol-profiles.md \u00b7 ADR 0023",
  },
  {
    id: "dpop",
    claim: "OpenSesame DPoP uses Authorization: DPoP plus a DPoP proof JWT.",
    detail:
      "opensesame-task-dpop-rfc9449-v1 is the default for task-secured broker invocations: DPoP-bound presentation, task binding, replay protection. Every built-in profile fails closed, so presenting Bearer where DPoP is required is rejected as a downgrade rather than quietly accepted.",
    source: "docs/protocol-profiles.md",
  },
  {
    id: "aauth",
    claim: "AAuth is an experimental adapter, disabled by default.",
    detail:
      "aauth-draft-10-experimental sits behind a Cargo feature flag and exposes no public endpoints. Its types and mappings are tested, but the draft can change and break the adapter without a major version bump.",
    source: "docs/protocol-profiles.md \u00b7 ADR 0025",
  },
  {
    id: "frozen-intent",
    claim:
      "DPoP does not bind query strings, bodies, or MCP tool arguments. FrozenIntent does.",
    detail:
      "A frozen intent takes a domain-separated digest over canonical bytes and binds the task run id, the task state version, and the task state digest. The broker verifies that digest against live task state and fails closed on a stale version, which is the part proof-of-possession alone cannot give you.",
    source: "ADR 0021 \u2014 Frozen intent",
  },
  {
    id: "connection-ref",
    claim: "Knowledge of a ConnectionRef is not capability.",
    detail:
      "Holding a handle never implies permission to resolve or export the material behind it. Agents receive a ConnectionRef and a typed intent; materializing a raw credential is a separate, explicitly requested, normally denied level.",
    source: "ADR 0005 \u2014 AuthorityHandle",
  },
];

type Discovery = Record<string, unknown>;

const DISCOVERY_URLS: Array<{ key: string; label: string }> = [
  { key: "issuer", label: "Issuer" },
  { key: "authorization_endpoint", label: "Authorization" },
  { key: "token_endpoint", label: "Token" },
  { key: "device_authorization_endpoint", label: "Device authorization" },
  { key: "jwks_uri", label: "JWKS" },
  { key: "userinfo_endpoint", label: "UserInfo" },
  { key: "introspection_endpoint", label: "Introspection" },
  { key: "revocation_endpoint", label: "Revocation" },
  { key: "registration_endpoint", label: "Registration" },
];

const DISCOVERY_LISTS: Array<{ key: string; label: string }> = [
  { key: "grant_types_supported", label: "Grant types" },
  { key: "code_challenge_methods_supported", label: "PKCE code challenge methods" },
  { key: "dpop_signing_alg_values_supported", label: "DPoP signing algorithms" },
  { key: "token_endpoint_auth_methods_supported", label: "Token endpoint auth methods" },
  { key: "response_types_supported", label: "Response types" },
  { key: "scopes_supported", label: "Scopes" },
];

function ProtocolArea() {
  const [doc, setDoc] = useState<Discovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const url = `${identityBase().replace(/\/+$/u, "")}/.well-known/openid-configuration`;
    try {
      // Public metadata: no credentials, so the wildcard CORS header applies.
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) {
        setDoc(null);
        setError(
          `The Identity API answered ${res.status} for its discovery document. The service is up but not serving OIDC metadata at ${url} — check that it is the control-plane and not another server on that port.`,
        );
        return;
      }
      setDoc((await res.json()) as Discovery);
    } catch {
      setDoc(null);
      setError(
        `Could not reach ${url}. The assertions below are still accurate — they describe the protocol this build implements — but nothing on this tab is confirmed against a running service until the Identity API answers.`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>What the protocol guarantees</h2>
            <p>Seven load-bearing facts, each with the place it is enforced.</p>
          </div>
        </div>
        <div className="panel__body">
          <p className="authority-prose">
            Every protocol adapter maps onto one canonical core: an identity produces an
            authority context, a task template compiles an immutable ceiling, current
            capabilities ratchet downward inside it, a frozen intent pins the exact
            operation, mediation issues a proof-bound credential, and enforcement leaves
            evidence. Adapters differ in how a caller presents a token. They do not differ
            in what authority means.
          </p>

          <dl className="authority-asserts">
            {ASSERTIONS.map((assertion) => (
              <div className="authority-assert" key={assertion.id}>
                <dt>{assertion.claim}</dt>
                <dd>
                  <p>{assertion.detail}</p>
                  <p className="authority-assert__source">{assertion.source}</p>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Advertised by the running identity plane</h2>
            <p>
              Live OIDC discovery from {identityBase()}, so you can check the deployment
              against the claims above rather than trusting the prose.
            </p>
          </div>
          <div className="actions actions--end">
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => void load()}
              disabled={loading}
              aria-busy={loading}
            >
              <IconRefresh size={16} />
              {loading ? "Fetching…" : "Refetch"}
            </button>
          </div>
        </div>
        <div className="panel__body">
          {error ? (
            <p className="note note--warn" role="status">
              <IconAlert size={18} />
              <span>{error}</span>
            </p>
          ) : null}

          {doc ? (
            <>
              <dl className="kv">
                {DISCOVERY_URLS.filter((entry) => typeof doc[entry.key] === "string").map(
                  (entry) => (
                    <div key={entry.key}>
                      <dt>{entry.label}</dt>
                      <dd className="authority-wrap">
                        <code>{doc[entry.key] as string}</code>
                      </dd>
                    </div>
                  ),
                )}
              </dl>

              <div className="authority-lists">
                {DISCOVERY_LISTS.map((entry) => {
                  const value = doc[entry.key];
                  const values = Array.isArray(value)
                    ? value.filter((item): item is string => typeof item === "string")
                    : null;
                  return (
                    <div className="authority-list" key={entry.key}>
                      <h3>{entry.label}</h3>
                      {values && values.length > 0 ? (
                        <div className="authority-chips">
                          {values.map((item) => (
                            <span
                              className={`chip${item === "S256" ? " chip--ok" : ""}`}
                              key={item}
                            >
                              {item}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="hint">Not advertised by this deployment.</p>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="hint">
                Read this against the assertions: a{" "}
                <code>code_challenge_methods_supported</code> without <code>S256</code>{" "}
                would contradict the PKCE requirement, and DPoP signing algorithms appear
                here only when the provider has the DPoP feature on. Absent keys mean the
                deployment does not advertise the capability — not that this page failed
                to read it.
              </p>
            </>
          ) : !error && loading ? (
            <p className="hint">Fetching discovery metadata…</p>
          ) : null}
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Outbox                                                              */
/* ------------------------------------------------------------------ */

type FlushResult = { id: string; label: string; ok: boolean; message: string };

function Outbox({
  items,
  online,
  session,
  onChange,
}: {
  items: QueuedAction[];
  online: boolean;
  session: IdentitySession | null;
  onChange: () => void;
}) {
  const [flushing, setFlushing] = useState(false);
  const [results, setResults] = useState<FlushResult[]>([]);

  async function flush() {
    setFlushing(true);
    setResults([]);
    const collected: FlushResult[] = [];

    for (const item of loadQueue()) {
      const label = describeQueued(item);
      try {
        if (item.kind === "device_approve") {
          if (!session) {
            collected.push({
              id: item.id,
              label,
              ok: false,
              message:
                "Needs a principal. Connect on the Session tab, then flush again — the code is still staged.",
            });
            continue;
          }
          const res = await identityFetch("/v1/device/approve", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ user_code: item.userCode }),
          });
          if (!res.ok) {
            collected.push({ id: item.id, label, ok: false, message: await describeApproveFailure(res) });
            continue;
          }
          dequeue(item.id);
          collected.push({ id: item.id, label, ok: true, message: "Device authorized." });
        } else {
          if (!session) {
            collected.push({
              id: item.id,
              label,
              ok: false,
              message:
                "Needs a principal. Connect on the Session tab, then flush again — the token is still staged.",
            });
            continue;
          }
          const { client } = createClaimClient(session);
          const claim = await client.presentClaim(item.claimToken);
          await client.completeClaim(claim.id, { acceptedItemIds: ["*"] });
          dequeue(item.id);
          collected.push({
            id: item.id,
            label,
            ok: true,
            message: `Claim ${claim.id} completed.`,
          });
        }
      } catch (err) {
        collected.push({
          id: item.id,
          label,
          ok: false,
          message: err instanceof Error ? `${err.message}. Still staged — flush again once that is fixed.` : "Failed for an unknown reason. Still staged.",
        });
      }
    }

    setResults(collected);
    onChange();
    setFlushing(false);
  }

  const failed = results.filter((result) => !result.ok).length;

  return (
    <section className="panel authority-outbox">
      <div className="panel__head">
        <div>
          <h2>
            Outbox
            <span className="chip chip--warn authority-outbox__count">{items.length}</span>
          </h2>
          <p>
            Ceremonies you started while offline. Nothing here has happened yet — these are
            codes and tokens you already typed, held so they are not lost.
          </p>
        </div>
        <div className="actions actions--end">
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => void flush()}
            disabled={!online || flushing}
            aria-busy={flushing}
          >
            <IconUpload size={16} />
            {flushing ? "Flushing…" : "Flush"}
          </button>
        </div>
      </div>
      <div className="panel__body">
        {!online ? (
          <p className="hint">Still offline. These will send when connectivity returns.</p>
        ) : null}

        <ul className="authority-outbox__list">
          {items.map((item) => {
            const result = results.find((entry) => entry.id === item.id);
            return (
              <li key={item.id} className="authority-outbox__row">
                <div>
                  <p className="authority-outbox__label">{describeQueued(item)}</p>
                  <p className="hint">Staged {formatWhen(item.createdAt)}</p>
                  {result && !result.ok ? (
                    <p className="authority-outbox__error">{result.message}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Discard ${describeQueued(item)}`}
                  onClick={() => {
                    dequeue(item.id);
                    onChange();
                  }}
                >
                  <IconX size={17} />
                </button>
              </li>
            );
          })}
        </ul>

        {results.length > 0 ? (
          <p
            className={`note note--${failed === 0 ? "ok" : "warn"}`}
            role="status"
          >
            {failed === 0 ? <IconCheck size={18} /> : <IconAlert size={18} />}
            <span>
              {results.length - failed} of {results.length} sent.
              {failed > 0
                ? " The ones that failed are still listed above with the reason; the rest were cleared."
                : ""}
            </span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

function describeQueued(item: QueuedAction): string {
  return item.kind === "device_approve"
    ? `Authorize device ${item.userCode}`
    : `Complete claim …${item.claimToken.slice(-8)}`;
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function CopyableId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <span className="authority-id">
      <code>{value}</code>
      <button
        type="button"
        className={`icon-btn${copied ? " is-on" : ""}`}
        aria-label={copied ? "Copied" : `Copy ${value}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
      </button>
    </span>
  );
}

function formatWhen(value: string | number | undefined): string {
  if (value === undefined) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function unreachableMessage(): string {
  return `Could not reach the Identity API at ${identityBase()}. Start it, or point this page somewhere else in Settings.`;
}

function describePrincipalError(err: unknown): string {
  if (err instanceof IdentityError) {
    if (err.status === 401) {
      return "Your session is no longer valid — it expired or was revoked. Disconnect and connect again.";
    }
    if (err.status === 403) {
      return "The Identity API refused to describe this principal. The token may belong to a different issuer than the one configured in Settings.";
    }
    if (err.status === 404) {
      return "The token authenticated, but the Identity API has no principal with that id. It was probably deleted — disconnect and create a new one.";
    }
    return `The Identity API answered ${err.status} for /v1/principals/me. ${
      err.message || "Check the service logs, then reload."
    }`;
  }
  return unreachableMessage();
}

function describeConnectError(err: unknown): string {
  if (err instanceof IdentityError) {
    if (err.status === 429) {
      return "The Identity API is rate-limiting provisional principals. Wait a moment and try again.";
    }
    if (err.status === 403) {
      return "This deployment does not allow anonymous provisional principals. Sign in with the opensesame-id CLI and adopt the token it prints instead.";
    }
    return `The Identity API answered ${err.status} when creating a provisional principal. ${
      err.message || "Check its logs."
    }`;
  }
  return unreachableMessage();
}

/** POST /v1/device/approve proxies to the Host API, so failures come from either plane. */
async function describeApproveFailure(res: Response): Promise<string> {
  const code = await readErrorCode(res);
  if (res.status === 401 || res.status === 403) {
    return "Your session cannot approve devices — connect a principal first, on the Session tab.";
  }
  if (res.status === 404) {
    return "That code is not recognised. User codes expire within minutes, so if it has been sitting a while, ask the device for a fresh one and retype it.";
  }
  if (res.status === 400) {
    return "The Identity API rejected the code as malformed. Check you copied all eight characters from the terminal.";
  }
  if (res.status === 503 && code === "operator_token_unconfigured") {
    return "The Identity API is running but cannot talk to the Host API: it has no operator token configured. Set OPENSESAME_OPERATOR_TOKEN on that service — this is server configuration, not something this page can supply.";
  }
  if (res.status === 502 && code === "host_api_unreachable") {
    return `The Identity API accepted your approval but could not reach the Host API at ${hostBase()}. Start the Host API, then try again.`;
  }
  if (res.status === 502) {
    return `The Host API rejected the approval${code ? ` (${code})` : ""}. The code may already have been used. Ask the device for a new one.`;
  }
  if (res.status === 500 && code?.startsWith("invalid_host_api_url")) {
    return "The Identity API has a malformed Host API address configured. Fix OPENSESAME_HOST_API on that service.";
  }
  return `The Identity API answered ${res.status}${code ? ` (${code})` : ""}. Check its logs, then try the code again — it has not been consumed.`;
}

function describePresentFailure(failure: TransportFailure): string {
  const { status, code } = failure;
  if (status === null) {
    return unreachableMessage();
  }
  if (status === 401) {
    return "That claim token is not valid. Either it was mistyped, or it has already been consumed — claim tokens are single-use.";
  }
  if (status === 404) {
    return "No claim exists for that token. Check you pasted the token for the claim you meant, not an older one.";
  }
  if (status === 410) {
    return "That claim has expired. Ask the tool that created it to issue a new one.";
  }
  if (status === 409) {
    return "Someone else is completing this claim right now. Wait a moment and present it again to see where it landed.";
  }
  if (status === 422) {
    return `The claim is not in a presentable state${code ? ` (${code})` : ""}. It has probably been completed or denied already.`;
  }
  return `The Identity API answered ${status}${code ? ` (${code})` : ""} when presenting the claim. Nothing was accepted; check its logs and try again.`;
}

function describeCompleteFailure(failure: TransportFailure, err: unknown): string {
  if (err instanceof Error && err.message.includes("Authentication required")) {
    return "Completing needs a principal, and the session was lost between presenting and completing. Connect on the Session tab and present the token again.";
  }
  const { status, code } = failure;
  if (status === null) {
    return unreachableMessage();
  }
  if (status === 401 || status === 403) {
    return "Your principal is not allowed to complete this claim. Connect a principal with the right authority, then present the token again.";
  }
  if (status === 404) {
    return "The claim disappeared between presenting and completing. Present the token again to see its current state.";
  }
  if (status === 410) {
    return "The claim expired while it was open for review. Ask for a new claim token.";
  }
  if (status === 409) {
    return "Another principal completed this claim first. Nothing was attached to you.";
  }
  if (status === 422) {
    return `The claim is not in a completable state${code ? ` (${code})` : ""} — it was denied, revoked, or already completed. Present the token again to see which.`;
  }
  return `The Identity API answered ${status}${code ? ` (${code})` : ""} when completing. Ownership did not move; check its logs and present the token again.`;
}
