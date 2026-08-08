import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  identityBase,
  identityFetch,
  useConnect,
  useIdentitySession,
  fetchPrincipal,
} from "../lib/identity.js";
import { useOnline } from "../lib/use-online.js";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconCopy,
  IconInfo,
  IconPlus,
  IconRefresh,
  IconShield,
  IconSite,
  IconTrash,
  IconX,
} from "../components/Icons.js";
import "./sites.css";

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

type AuditEvent = {
  id: string;
  occurredAt: string;
  eventType: string;
  outcome: string;
  correlationId?: string;
  clientId?: string;
  metadata?: Record<string, unknown>;
};

type Flash = { tone: "ok" | "warn" | "err"; text: string };

/** Scopes this form can request. `openid` is mandatory for an OIDC client. */
const SCOPE_CHOICES = [
  { value: "openid", hint: "Required. Issues an ID token for the signed-in principal." },
  { value: "profile", hint: "Display name and profile claims on the ID token." },
  { value: "email", hint: "Email claim, when the principal has a verified email identity." },
  { value: "offline_access", hint: "Refresh token, so the site can stay signed in." },
];

/** Stands in for the client id until the origin has actually been registered. */
const CLIENT_ID_SLOT = "REPLACE_WITH_CLIENT_ID";

const DRAFT_OPTION = "__draft";

const GRANT_TYPES = ["authorization_code", "refresh_token"];
const RESPONSE_TYPES = ["code"];
const TOKEN_AUTH_METHOD = "none";

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

function messageFrom(body: unknown): string | null {
  if (body && typeof body === "object" && "message" in body) {
    const value = (body as { message?: unknown }).message;
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function codeFrom(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const value = (body as { error?: unknown }).error;
    if (typeof value === "string" && value.trim()) return value;
  }
  return "unknown_error";
}

function fieldErrorsFrom(body: unknown): string[] {
  if (!body || typeof body !== "object" || !("details" in body)) return [];
  const details = (body as { details?: unknown }).details;
  if (!details || typeof details !== "object") return [];
  const out: string[] = [];
  const form = (details as { formErrors?: unknown }).formErrors;
  if (Array.isArray(form)) {
    for (const item of form) if (typeof item === "string") out.push(item);
  }
  const fields = (details as { fieldErrors?: unknown }).fieldErrors;
  if (fields && typeof fields === "object") {
    for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") out.push(`${key}: ${item}`);
        }
      }
    }
  }
  return out;
}

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
  const body: unknown = await res.json().catch(() => null);
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
  return body as T;
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return "Unknown error.";
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
    return { ok: false, message: "Enter the origin your site is served from, for example https://example.com." };
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
    return { ok: false, message: `“${value}” is not a URL the browser can parse.` };
  }
  if (url.username || url.password) {
    return { ok: false, message: "Remove the credentials (the user:password@ part) — an origin carries none." };
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
    return { ok: false, message: `An origin has no path — drop “${url.pathname}”. The callback path is a separate field below.` };
  }
  if (url.search) {
    return { ok: false, message: `An origin has no query string — drop “${url.search}”.` };
  }
  if (url.hash) {
    return { ok: false, message: `An origin has no fragment — drop “${url.hash}”.` };
  }
  if (url.protocol === "https:" && /:443(?:\/|$)/.test(value)) {
    return { ok: false, message: "Drop the default port :443 — https://host already means that, and the browser will send the origin without it." };
  }
  if (url.protocol === "http:" && /:80(?:\/|$)/.test(value)) {
    return { ok: false, message: "Drop the default port :80 — http://host already means that, and the browser will send the origin without it." };
  }
  return { ok: true, origin: url.origin, host: url.host };
}

function normalisePath(raw: string): string {
  const value = raw.trim();
  if (!value) return "/callback";
  return value.startsWith("/") ? value : `/${value}`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatWhen(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : timeFormat.format(at);
}

function quoteList(values: string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function buildSignInSnippet(input: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
}): string {
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

function buildCallbackSnippet(input: { redirectUri: string }): string {
  return `// The page served at ${input.redirectUri}
import { sesame } from "./auth.js";

// Verifies state, replays the stored PKCE verifier, and exchanges ?code=
// for tokens. Throws if state does not match or the code is missing.
const session = await sesame.handleRedirectCallback();
console.log(session.sub, session.accessToken);

// Anywhere else in the site:
const current = await sesame.getSession(); // null when absent or expired
// await sesame.signOut();`;
}

export function SitesSection() {
  const session = useIdentitySession();
  const online = useOnline();
  const { connecting, error: connectError, connect } = useConnect();
  const base = identityBase();

  const [clients, setClients] = useState<OAuthClient[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [loadingClients, setLoadingClients] = useState(false);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [assurance, setAssurance] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [snippetClientId, setSnippetClientId] = useState<string | null>(null);
  const [originInput, setOriginInput] = useState("");
  const [callbackPath, setCallbackPath] = useState("/callback");

  const token = session?.accessToken ?? null;

  const loadClients = useCallback(async () => {
    setLoadingClients(true);
    try {
      const data = await callIdentity<{ clients: OAuthClient[] }>("/v1/oauth/clients");
      setClients(data.clients);
      setClientsError(null);
    } catch (error) {
      setClients(null);
      setClientsError(errorText(error));
    } finally {
      setLoadingClients(false);
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const data = await callIdentity<{ events: AuditEvent[] }>(
        "/v1/audit/events?limit=50",
      );
      setEvents(data.events);
      setEventsError(null);
    } catch (error) {
      setEvents(null);
      setEventsError(errorText(error));
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([loadClients(), loadEvents()]);
  }, [loadClients, loadEvents]);

  useEffect(() => {
    if (!token) {
      setClients(null);
      setEvents(null);
      setAssurance(null);
      return;
    }
    void refresh();
    let cancelled = false;
    void fetchPrincipal()
      .then((principal) => {
        if (!cancelled) setAssurance(principal.assurance);
      })
      .catch(() => {
        if (!cancelled) setAssurance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token, refresh]);

  const activeClients = useMemo(
    () => (clients ?? []).filter((client) => client.state !== "revoked"),
    [clients],
  );

  const snippetClient = useMemo(() => {
    if (activeClients.length === 0) return null;
    return (
      activeClients.find((client) => client.id === snippetClientId) ??
      activeClients[0] ??
      null
    );
  }, [activeClients, snippetClientId]);

  /** Lets the snippet track the origin being typed, before any client exists. */
  const draft = useMemo(() => {
    const check = checkOrigin(originInput);
    if (!check.ok) return null;
    return {
      host: check.host,
      redirectUri: `${check.origin}${normalisePath(callbackPath)}`,
    };
  }, [originInput, callbackPath]);

  if (!session) {
    return (
      <div className="section__inner">
        <SitesHead base={base} />
        <div className="panel">
          <div className="panel__body">
            <div className="empty sites-connect">
              <span className="empty__mark">
                <IconSite />
              </span>
              <h3>Connect to manage your sites</h3>
              <p>
                Every part of this section is a live read or write against the Identity
                plane at <code>{base}</code>: the OAuth clients it will accept, the
                registration of a new one for an origin you control, and the sign-in
                events those clients produced. None of it can be shown without a
                principal session.
              </p>
              {online ? null : (
                <p className="note note--warn">
                  <IconAlert /> This browser is offline. Connecting needs a reachable
                  Identity plane — reconnect and try again.
                </p>
              )}
              {connectError ? (
                <p className="note note--err">
                  <IconAlert /> {errorText(connectError)} Check that the Identity API is
                  running at <code>{base}</code>, or change the address under Settings.
                </p>
              ) : null}
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void connect()}
                disabled={connecting || !online}
              >
                {connecting ? "Connecting…" : "Connect a provisional session"}
              </button>
              <p className="hint">
                A provisional session can list clients and read your audit trail.
                Registering a new client needs a verified identity — the Identity plane
                rejects registration below that bar.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section__inner">
      <SitesHead base={base} />

      {flash ? (
        <div className={`note note--${flash.tone} sites-flash`} role="status">
          {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
          <p>{flash.text}</p>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setFlash(null)}
            aria-label="Dismiss"
          >
            <IconX />
          </button>
        </div>
      ) : null}

      <ClientsPanel
        clients={clients}
        activeClients={activeClients}
        loading={loadingClients}
        error={clientsError}
        online={online}
        onRefresh={() => void refresh()}
        onFlash={setFlash}
        onUseSnippet={setSnippetClientId}
        afterMutation={() => void refresh()}
      />

      <RegisterPanel
        assurance={assurance}
        online={online}
        originInput={originInput}
        onOriginInput={setOriginInput}
        callbackPath={callbackPath}
        onCallbackPath={setCallbackPath}
        onFlash={setFlash}
        onRegistered={(client) => {
          setSnippetClientId(client.id);
          void refresh();
        }}
      />

      <SnippetPanel
        base={base}
        client={snippetClient}
        clients={activeClients}
        draft={draft}
        pinned={snippetClientId !== null}
        onSelect={setSnippetClientId}
      />

      <ActivityPanel events={events} error={eventsError} clients={clients ?? []} />
    </div>
  );
}

function SitesHead({ base }: { base: string }) {
  return (
    <header className="section__head">
      <h1>Sites</h1>
      <p>
        A website uses OpenSesame as its auth broker: a static page adds a sign-in
        button and gets an OAuth 2.0 authorization-code flow with PKCE S256 against{" "}
        <code>{base}</code>, using a public client pinned to that site&rsquo;s own
        origin. Register those clients here, retire them, and watch them being used.
      </p>
    </header>
  );
}

type ConfirmTarget = { id: string; action: "rotate" | "revoke" };

function ClientsPanel({
  clients,
  activeClients,
  loading,
  error,
  online,
  onRefresh,
  onFlash,
  onUseSnippet,
  afterMutation,
}: {
  clients: OAuthClient[] | null;
  activeClients: OAuthClient[];
  loading: boolean;
  error: string | null;
  online: boolean;
  onRefresh: () => void;
  onFlash: (flash: Flash) => void;
  onUseSnippet: (id: string) => void;
  afterMutation: () => void;
}) {
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const revoked = (clients ?? []).filter((client) => client.state === "revoked");

  async function run(client: OAuthClient, action: "rotate" | "revoke") {
    setBusy(client.id);
    try {
      if (action === "rotate") {
        const next = await callIdentity<OAuthClient>(
          `/v1/oauth/clients/${encodeURIComponent(client.id)}/rotate`,
          { method: "POST" },
        );
        onUseSnippet(next.id);
        onFlash({
          tone: "ok",
          text: `${client.displayName} now uses client id ${next.id}. The previous id ${client.id} is revoked — paste the updated snippet into the site before its next sign-in, or the authorization request will be rejected.`,
        });
      } else {
        await callIdentity<OAuthClient>(
          `/v1/oauth/clients/${encodeURIComponent(client.id)}/revoke`,
          { method: "POST" },
        );
        onFlash({
          tone: "warn",
          text: `${client.displayName} is revoked. It has left the list, no new sign-in through ${client.id} will succeed, and restoring it means registering the origin again.`,
        });
      }
      setConfirm(null);
      afterMutation();
    } catch (mutationError) {
      onFlash({ tone: "err", text: errorText(mutationError) });
      if (mutationError instanceof SitesError && mutationError.status === 404) {
        setConfirm(null);
        afterMutation();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Registered clients</h2>
          <p>
            Every client the Identity plane will accept an authorization request from.
            Revoked clients are dropped by the API and never returned here.
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={onRefresh}
            disabled={loading}
          >
            <IconRefresh /> {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      <div className="panel__body panel__body--tight">
        {error ? (
          <div className="sites-pad">
            <p className="note note--err" role="alert">
              <IconAlert /> {error}
            </p>
            <div className="actions">
              <button type="button" className="btn btn--sm" onClick={onRefresh}>
                <IconRefresh /> Try again
              </button>
            </div>
          </div>
        ) : clients === null ? (
          <p className="sites-pad hint" role="status">
            Reading clients from the Identity plane…
          </p>
        ) : activeClients.length === 0 && revoked.length === 0 ? (
          <div className="empty">
            <span className="empty__mark">
              <IconSite />
            </span>
            <h3>No clients registered</h3>
            <p>
              This Identity plane has no OAuth client yet, so no website can start a
              sign-in against it. Register the first origin below.
            </p>
          </div>
        ) : (
          <ul className="sites-list">
            {[...activeClients, ...revoked].map((client) => (
              <ClientRow
                key={client.id}
                client={client}
                busy={busy === client.id}
                online={online}
                confirm={confirm?.id === client.id ? confirm.action : null}
                onConfirm={(action) => setConfirm({ id: client.id, action })}
                onCancel={() => setConfirm(null)}
                onRun={(action) => void run(client, action)}
                onUseSnippet={() => onUseSnippet(client.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ClientRow({
  client,
  busy,
  online,
  confirm,
  onConfirm,
  onCancel,
  onRun,
  onUseSnippet,
}: {
  client: OAuthClient;
  busy: boolean;
  online: boolean;
  confirm: "rotate" | "revoke" | null;
  onConfirm: (action: "rotate" | "revoke") => void;
  onCancel: () => void;
  onRun: (action: "rotate" | "revoke") => void;
  onUseSnippet: () => void;
}) {
  const dead = client.state === "revoked";
  const stateChip =
    client.state === "active"
      ? "chip--ok"
      : client.state === "suspended"
        ? "chip--warn"
        : "chip--err";

  return (
    <li className={dead ? "sites-client is-revoked" : "sites-client"}>
      <div className="sites-client__top">
        <div className="sites-client__title">
          <h3>{client.displayName}</h3>
          <p className="sites-client__id">{client.id}</p>
        </div>
        <div className="sites-client__chips">
          <span className={`chip ${stateChip}`}>{client.state}</span>
          <span className="chip">{client.admissionMode}</span>
          <span className="chip">auth: {client.tokenEndpointAuthMethod}</span>
        </div>
      </div>

      <dl className="kv">
        <div>
          <dt>Sector identifier</dt>
          <dd>{client.sectorIdentifier}</dd>
        </div>
        <div>
          <dt>Redirect URIs</dt>
          <dd>
            <ul className="sites-uris">
              {client.redirectUris.map((uri) => (
                <li key={uri}>{uri}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Scopes</dt>
          <dd>{client.allowedScopes.join(" ") || "—"}</dd>
        </div>
        <div>
          <dt>Grants</dt>
          <dd>{client.grantTypes.join(", ")}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>
            <time dateTime={client.updatedAt}>{formatWhen(client.updatedAt)}</time>
          </dd>
        </div>
      </dl>

      {dead ? (
        <p className="hint">
          Revoked {formatWhen(client.updatedAt)}. Kept visible only until the next
          refresh — the list endpoint omits revoked clients.
        </p>
      ) : confirm ? (
        <div className="sites-confirm" role="group" aria-label={`Confirm ${confirm}`}>
          <p>
            {confirm === "rotate" ? (
              <>
                <strong>Rotating issues a new client id and revokes {client.id} in
                the same step.</strong>{" "}
                The site keeps its redirect URI, scopes, and sector identifier, but
                every page still sending the old id will be rejected at the
                authorization endpoint until you paste the new snippet.
              </>
            ) : (
              <>
                <strong>Revoking ends sign-in through {client.displayName}
                immediately.</strong>{" "}
                Access tokens already issued stay valid until they expire; no new
                authorization will succeed. This cannot be undone — restoring the site
                means registering the origin again as a new client id.
              </>
            )}
          </p>
          <div className="actions actions--end">
            <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className={confirm === "revoke" ? "btn btn--sm btn--danger" : "btn btn--sm btn--primary"}
              onClick={() => onRun(confirm)}
              disabled={busy || !online}
              autoFocus
            >
              {busy
                ? confirm === "rotate"
                  ? "Rotating…"
                  : "Revoking…"
                : confirm === "rotate"
                  ? "Rotate and revoke old id"
                  : "Revoke this client"}
            </button>
          </div>
        </div>
      ) : (
        <div className="actions actions--end">
          <button type="button" className="btn btn--sm btn--ghost" onClick={onUseSnippet}>
            <IconCopy /> Use in snippet
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onConfirm("rotate")}
            disabled={busy}
          >
            <IconRefresh /> Rotate
          </button>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            onClick={() => onConfirm("revoke")}
            disabled={busy}
          >
            <IconTrash /> Revoke
          </button>
        </div>
      )}
    </li>
  );
}

function RegisterPanel({
  assurance,
  online,
  originInput,
  onOriginInput,
  callbackPath,
  onCallbackPath,
  onFlash,
  onRegistered,
}: {
  assurance: string | null;
  online: boolean;
  originInput: string;
  onOriginInput: (value: string) => void;
  callbackPath: string;
  onCallbackPath: (value: string) => void;
  onFlash: (flash: Flash) => void;
  onRegistered: (client: OAuthClient) => void;
}) {
  const fieldId = useId();
  const [originTouched, setOriginTouched] = useState(false);
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
  const provisional = assurance === "provisional";

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
      setFormError("Give the site a display name — it is what a person sees on the consent screen.");
      return;
    }
    if (!sectorIdentifier.trim()) {
      setFormError("The sector identifier cannot be empty; it groups redirect URIs that share one subject.");
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
      onFlash({
        tone: "ok",
        text: `${client.displayName} is registered as ${client.id}. The integration snippet below is now filled in with that id and ${redirectUri}.`,
      });
      onRegistered(client);
      setOriginTouched(false);
      setNameInput("");
      setNameTouched(false);
      setSectorInput("");
      setSectorTouched(false);
    } catch (error) {
      if (error instanceof SitesError && error.code === "assurance_too_low") {
        setBlocked(
          "A provisional session can browse clients and read its audit trail, but it cannot register one. Verify your identity on the Identity plane first — link a real identity there, then come back and this form will submit unchanged.",
        );
      } else {
        setFormError(errorText(error));
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
          <p>
            Pins a public client to one origin. Everything except the name and scopes is
            derived from that origin, because the origin is what the authorization
            endpoint checks.
          </p>
        </div>
      </div>
      <div className="panel__body">
        {provisional ? (
          <p className="note note--warn">
            <IconShield /> This session is provisional. The Identity plane will reject
            the registration below with <code>assurance_too_low</code> until a real
            identity is linked on the Identity plane. Reading clients still works.
          </p>
        ) : null}

        <form className="sites-form" onSubmit={submit} noValidate>
          <div className="sites-form__fields">
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
                onChange={(event) => onOriginInput(event.target.value)}
                onBlur={() => setOriginTouched(true)}
                aria-invalid={originTouched && !check.ok ? true : undefined}
                aria-describedby={`${fieldId}-origin-hint`}
              />
              <p className="hint" id={`${fieldId}-origin-hint`}>
                Scheme and host only. https is required, except for{" "}
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
                onChange={(event) => onCallbackPath(event.target.value)}
                aria-describedby={`${fieldId}-path-hint`}
              />
              <p className="hint" id={`${fieldId}-path-hint`}>
                The page that calls <code>handleRedirectCallback()</code>. It must exist
                on the site; the SDK defaults to <code>/callback</code>.
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
                aria-describedby={`${fieldId}-name-hint`}
              />
              <p className="hint" id={`${fieldId}-name-hint`}>
                Shown to the person being asked to sign in. Defaults to the host.
              </p>
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
                aria-describedby={`${fieldId}-sector-hint`}
              />
              <p className="hint" id={`${fieldId}-sector-hint`}>
                Clients sharing a sector see the same subject for one principal. Keep the
                origin unless you run several origins that must look like one site.
              </p>
            </div>

            <fieldset className="field sites-scopes">
              <legend className="label">Scopes</legend>
              {SCOPE_CHOICES.map((scope) => (
                <label className="check" key={scope.value}>
                  <input
                    type="checkbox"
                    checked={scope.value === "openid" ? true : scopes.includes(scope.value)}
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

          <aside className="sites-derived" aria-label="Values that will be sent">
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
            <p className="hint">
              <IconInfo /> Dynamic registration, client metadata documents, and origin
              profiles are rejected by this API with{" "}
              <code>admission_mode_disabled</code>, so this form only offers the mode
              that works.
            </p>
          </aside>

          <div className="sites-form__submit">
            {blocked ? (
              <p className="note note--warn" role="alert">
                <IconShield /> {blocked}
              </p>
            ) : null}
            {formError ? (
              <p className="note note--err" role="alert">
                <IconAlert /> {formError}
              </p>
            ) : null}
            {online ? null : (
              <p className="note note--warn">
                <IconAlert /> Offline — registration needs a reachable Identity plane.
              </p>
            )}
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting || !online}
            >
              <IconPlus /> {submitting ? "Registering…" : "Register client"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function SnippetPanel({
  base,
  client: selected,
  clients,
  draft,
  pinned,
  onSelect,
}: {
  base: string;
  client: OAuthClient | null;
  clients: OAuthClient[];
  draft: { host: string; redirectUri: string } | null;
  pinned: boolean;
  onSelect: (id: string | null) => void;
}) {
  const selectId = useId();
  const panelId = `${selectId}-code`;
  const [tab, setTab] = useState<"signin" | "callback">("signin");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  /* An origin being typed that no client covers yet takes the stage, unless the
     user has deliberately pinned a client to this panel. */
  const draftIsNew =
    draft !== null &&
    !clients.some((option) => option.redirectUris.includes(draft.redirectUri));
  const client = pinned || !draftIsNew ? selected : null;

  const redirectUri = client?.redirectUris[0] ?? draft?.redirectUri ?? null;
  const unregistered = !client && draft !== null;
  const code = useMemo(() => {
    if (!redirectUri) return null;
    if (tab === "callback") return buildCallbackSnippet({ redirectUri });
    return buildSignInSnippet({
      issuer: base,
      clientId: client ? client.id : CLIENT_ID_SLOT,
      redirectUri,
      scopes: client ? client.allowedScopes : ["openid", "profile"],
    });
  }, [base, client, redirectUri, tab]);

  async function copy() {
    if (!code) return;
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
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Integration</h2>
          <p>
            {client
              ? `Issuer, client id, and redirect URI exactly as the Identity plane holds them for ${client.displayName}.`
              : "The code that turns an origin into a sign-in. Register the origin to get its client id."}
          </p>
        </div>
        {clients.length > 0 && redirectUri ? (
          <div className="actions">
            <label className="label sites-select-label" htmlFor={selectId}>
              Snippet for
            </label>
            <select
              id={selectId}
              value={client ? client.id : DRAFT_OPTION}
              onChange={(event) =>
                onSelect(event.target.value === DRAFT_OPTION ? null : event.target.value)
              }
            >
              {draftIsNew && draft ? (
                <option value={DRAFT_OPTION}>{draft.host} — not registered</option>
              ) : null}
              {clients.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.displayName}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className="panel__body">
        {!code ? (
          <div className="empty">
            <span className="empty__mark">
              <IconCopy />
            </span>
            <h3>Type an origin to see its snippet</h3>
            <p>
              The code needs a redirect URI, and the redirect URI comes from the origin.
              Enter one in the form above — or register it — and the snippet appears here
              with the real values in place.
            </p>
          </div>
        ) : (
          <>
            {unregistered && draft ? (
              <p className="note note--warn">
                <IconAlert /> {draft.host} is not registered yet, so{" "}
                <code>{CLIENT_ID_SLOT}</code> is standing in for a client id that does
                not exist. Register the origin above and the real id replaces it here.
              </p>
            ) : null}
            <div className="sites-toolbar">
              <div className="sites-tabs" role="tablist" aria-label="Integration snippet">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "signin"}
                  aria-controls={panelId}
                  className={tab === "signin" ? "sites-tab is-on" : "sites-tab"}
                  onClick={() => setTab("signin")}
                >
                  Sign-in
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "callback"}
                  aria-controls={panelId}
                  className={tab === "callback" ? "sites-tab is-on" : "sites-tab"}
                  onClick={() => setTab("callback")}
                >
                  Callback page
                </button>
              </div>
              <button
                type="button"
                className="btn btn--sm sites-copy"
                onClick={() => void copy()}
              >
                {copied ? <IconCheck /> : <IconCopy />} {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre
              className="sites-code"
              id={panelId}
              role="tabpanel"
              aria-label={tab === "signin" ? "Sign-in module" : "Callback page"}
              tabIndex={0}
            >
              <code>{code}</code>
            </pre>
            {copyError ? (
              <p className="note note--err" role="alert">
                <IconAlert /> {copyError}
              </p>
            ) : null}
            <p className="hint">
              <code>@opensesame/sdk-browser</code> ships as ESM source in this
              repository and has no script-tag or CDN build, so the site needs a bundler
              (Vite, esbuild, Rollup) to use it. It keeps PKCE state and the session in{" "}
              <code>sessionStorage</code>, never <code>localStorage</code>; pass{" "}
              <code>storage</code> to override.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function ActivityPanel({
  events,
  error,
  clients,
}: {
  events: AuditEvent[] | null;
  error: string | null;
  clients: OAuthClient[];
}) {
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const client of clients) map.set(client.id, client.displayName);
    return map;
  }, [clients]);

  const rows = useMemo(
    () =>
      (events ?? []).filter(
        (event) => event.eventType.startsWith("oauth_client.") || Boolean(event.clientId),
      ),
    [events],
  );

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Sign-in activity</h2>
          <p>
            Your last 50 audit entries, narrowed to the ones a client is party to. The
            Identity plane only returns your own trail.
          </p>
        </div>
      </div>
      <div className="panel__body panel__body--tight">
        {error ? (
          <p className="sites-pad note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : events === null ? (
          <p className="sites-pad hint" role="status">
            Reading the audit trail…
          </p>
        ) : rows.length === 0 ? (
          <div className="empty">
            <span className="empty__mark">
              <IconClock />
            </span>
            <h3>No client activity yet</h3>
            <p>
              Nothing in your last 50 audit entries involves an OAuth client. Registering
              one, rotating it, or completing a sign-in through it will show up here.
            </p>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Event</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Client</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <time dateTime={event.occurredAt}>{formatWhen(event.occurredAt)}</time>
                    </td>
                    <td>{event.eventType}</td>
                    <td>
                      <span
                        className={
                          event.outcome === "succeeded" ? "chip chip--ok" : "chip chip--err"
                        }
                      >
                        {event.outcome}
                      </span>
                    </td>
                    <td>
                      {event.clientId ? (
                        <span className="sites-event-client">
                          <span>{names.get(event.clientId) ?? "Revoked or unknown client"}</span>
                          <span className="sites-client__id">{event.clientId}</span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
