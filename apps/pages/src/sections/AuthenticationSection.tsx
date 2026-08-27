import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { IconPasskey, IconRefresh, IconTrash } from "../components/Icons.js";
import {
  type AuthenticationApplicationView,
  type AuthenticationEventView,
  type AuthenticationUserView,
  createAuthenticationApiKey,
  createAuthenticationApplication,
  deleteAuthenticationApiKey,
  exchangeAuthenticationToken,
  listAuthenticationApplications,
  listAuthenticationEvents,
  listAuthenticationOrganizationEvents,
  listAuthenticationUsers,
  registerPwaPasskey,
  removeAuthenticationCredential,
  rotateAuthenticationApplicationSecret,
  signinWithAuthenticationService,
  updateAuthenticationApiKey,
  updateAuthenticationApplication,
} from "../lib/authentication-service.js";
import { useConnect, useIdentitySession } from "../lib/identity.js";
import { type OrgMembership, listOrgMemberships } from "../lib/orgs.js";
import "./settings.css";

type Notice = { tone: "ok" | "err"; text: string };

function applicationState(
  value: string,
): AuthenticationApplicationView["state"] | undefined {
  return value === "active" || value === "suspended" || value === "revoked"
    ? value
    : undefined;
}

function authenticationMode(
  value: string,
): "autofill" | "discoverable" | "alias" | "user_id" | undefined {
  if (
    value === "autofill" ||
    value === "discoverable" ||
    value === "alias" ||
    value === "user_id"
  ) {
    return value;
  }
  return undefined;
}

function userVerification(
  value: string,
):
  | AuthenticationApplicationView["configurations"][number]["userVerification"]
  | undefined {
  return value === "discouraged" ||
    value === "preferred" ||
    value === "required"
    ? value
    : undefined;
}

export const authenticationSectionSeams = {
  createAuthenticationApplication,
  createAuthenticationApiKey,
  deleteAuthenticationApiKey,
  exchangeAuthenticationToken,
  listAuthenticationApplications,
  listAuthenticationEvents,
  listAuthenticationOrganizationEvents,
  listAuthenticationUsers,
  listOrgMemberships,
  registerPwaPasskey,
  removeAuthenticationCredential,
  rotateAuthenticationApplicationSecret,
  signinWithAuthenticationService,
  updateAuthenticationApiKey,
  updateAuthenticationApplication,
};

export function AuthenticationSection() {
  const session = useIdentitySession();
  const { connect, connecting, error: connectError } = useConnect();
  const [applications, setApplications] = useState<
    AuthenticationApplicationView[]
  >([]);
  const [organizations, setOrganizations] = useState<OrgMembership[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [users, setUsers] = useState<AuthenticationUserView[]>([]);
  const [events, setEvents] = useState<AuthenticationEventView[]>([]);
  const [organizationEvents, setOrganizationEvents] = useState<
    AuthenticationEventView[]
  >([]);
  const [apiSecret, setApiSecret] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState("OpenSesame PWA");
  const [rpId, setRpId] = useState(() => window.location.hostname);
  const [origin, setOrigin] = useState(() => window.location.origin);
  const [organizationId, setOrganizationId] = useState("");
  const [userName, setUserName] = useState("");
  const [alias, setAlias] = useState("");
  const [credentialName, setCredentialName] = useState("This device");
  const [signinMode, setSigninMode] = useState<
    "autofill" | "discoverable" | "alias" | "user_id"
  >("discoverable");
  const [signinValue, setSigninValue] = useState("");
  const [signinPurpose, setSigninPurpose] = useState("sign-in");
  const [customPurpose, setCustomPurpose] = useState("");

  const selected = useMemo(
    () =>
      applications.find((application) => application.id === selectedId) ?? null,
    [applications, selectedId],
  );
  const canRunHere = Boolean(
    selected?.origins.includes(window.location.origin) &&
      selected.rpId === window.location.hostname &&
      window.PublicKeyCredential,
  );

  const load = useCallback(async () => {
    if (!session) return;
    const [nextApplications, nextOrganizations] = await Promise.all([
      authenticationSectionSeams.listAuthenticationApplications(),
      authenticationSectionSeams.listOrgMemberships(),
    ]);
    setApplications(nextApplications);
    setOrganizations(
      nextOrganizations.filter(
        (org) => org.role === "owner" || org.role === "admin",
      ),
    );
    setSelectedId((current) =>
      nextApplications.some((application) => application.id === current)
        ? current
        : (nextApplications[0]?.id ?? ""),
    );
  }, [session]);

  const loadDetails = useCallback(async () => {
    if (!selected) {
      setUsers([]);
      setEvents([]);
      setOrganizationEvents([]);
      return;
    }
    const [nextUsers, nextEvents, nextOrganizationEvents] = await Promise.all([
      authenticationSectionSeams.listAuthenticationUsers(selected.id),
      authenticationSectionSeams.listAuthenticationEvents(selected.id),
      selected.organizationId
        ? authenticationSectionSeams.listAuthenticationOrganizationEvents(
            selected.organizationId,
          )
        : Promise.resolve([]),
    ]);
    setUsers(nextUsers);
    setEvents(nextEvents);
    setOrganizationEvents(nextOrganizationEvents);
  }, [selected]);

  useEffect(() => {
    void load().catch((error) =>
      setNotice({
        tone: "err",
        text: error instanceof Error ? error.message : "Load failed.",
      }),
    );
  }, [load]);

  useEffect(() => {
    void loadDetails().catch((error) =>
      setNotice({
        tone: "err",
        text: error instanceof Error ? error.message : "Load failed.",
      }),
    );
  }, [loadDetails]);

  async function createApplication(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const created =
        await authenticationSectionSeams.createAuthenticationApplication({
          displayName,
          rpId,
          origins: [origin],
          ...(organizationId ? { organizationId } : undefined),
        });
      setApiSecret(created.apiSecret);
      await load();
      setSelectedId(created.application.id);
      setNotice({
        tone: "ok",
        text: "Application created. Copy the API secret now; it is never stored in this PWA.",
      });
    } catch (error) {
      setNotice({
        tone: "err",
        text: error instanceof Error ? error.message : "Create failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function register(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setNotice(null);
    try {
      await authenticationSectionSeams.registerPwaPasskey({
        applicationId: selected.id,
        userName,
        alias,
        credentialName,
      });
      await loadDetails();
      setNotice({
        tone: "ok",
        text: "Passkey registered through the shared browser client.",
      });
    } catch (error) {
      setNotice({
        tone: "err",
        text: error instanceof Error ? error.message : "Registration failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setNotice(null);
    try {
      const result =
        await authenticationSectionSeams.signinWithAuthenticationService(
          selected.id,
          signinMode === "alias"
            ? { mode: "alias", alias: signinValue, purpose: signinPurpose }
            : signinMode === "user_id"
              ? { mode: "user_id", userId: signinValue, purpose: signinPurpose }
              : { mode: signinMode, purpose: signinPurpose },
        );
      const verified = apiSecret
        ? await authenticationSectionSeams.exchangeAuthenticationToken(
            selected.id,
            apiSecret,
            result.token,
          )
        : null;
      await loadDetails();
      setNotice({
        tone: "ok",
        text: verified
          ? `Signed in as ${verified.userId}; the one-time backend exchange succeeded.`
          : "Passkey assertion succeeded. Exchange the returned token from your backend with the application secret.",
      });
    } catch (error) {
      setNotice({
        tone: "err",
        text: error instanceof Error ? error.message : "Sign-in failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function patchSelected(
    patch: Parameters<typeof updateAuthenticationApplication>[1],
  ) {
    if (!selected) return;
    setBusy(true);
    try {
      await authenticationSectionSeams.updateAuthenticationApplication(
        selected.id,
        patch,
      );
      await load();
      setNotice({ tone: "ok", text: "Application settings updated." });
    } catch (error) {
      setNotice({
        tone: "err",
        text: error instanceof Error ? error.message : "Update failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function saveConfiguration(
    event: FormEvent<HTMLFormElement>,
    purpose: string,
  ) {
    event.preventDefault();
    if (!selected) return;
    const data = new FormData(event.currentTarget);
    const timeToLiveSeconds = Number(data.get("timeToLiveSeconds"));
    const verification = userVerification(String(data.get("userVerification")));
    if (!verification) return;
    const configurations = selected.configurations.map((configuration) =>
      configuration.purpose === purpose
        ? {
            ...configuration,
            timeToLiveSeconds,
            userVerification: verification,
          }
        : configuration,
    );
    await patchSelected({ configurations });
  }

  async function addConfiguration(event: FormEvent) {
    event.preventDefault();
    if (!selected || !customPurpose) return;
    await patchSelected({
      configurations: [
        ...selected.configurations,
        {
          purpose: customPurpose,
          timeToLiveSeconds: 180,
          userVerification: "required",
          hints: [],
        },
      ],
    });
    setCustomPurpose("");
  }

  if (!session) {
    return (
      <div className="stack">
        <header className="section__head">
          <div>
            <p className="eyebrow">Identity plane</p>
            <h1>Authentication service</h1>
          </div>
        </header>
        <section className="panel">
          <div className="panel__body stack">
            <p>
              Connect Identity to manage passwordless applications, users,
              credentials, and audit events.
            </p>
            <button
              type="button"
              className="button button--primary"
              disabled={connecting}
              onClick={() => void connect()}
            >
              {connecting ? "Connecting…" : "Connect Identity"}
            </button>
            {connectError ? (
              <p className="note note--err">{connectError}</p>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="stack">
      <header className="section__head">
        <div>
          <p className="eyebrow">Free and self-hostable</p>
          <h1>Authentication service</h1>
          <p className="section__lead">
            FIDO2 WebAuthn for customer and workforce apps, with no application,
            administrator, or user license cap.
          </p>
        </div>
        <button type="button" className="button" onClick={() => void load()}>
          <IconRefresh size={16} /> Refresh
        </button>
      </header>

      {notice ? (
        <p className={`note note--${notice.tone}`}>{notice.text}</p>
      ) : null}

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Applications</h2>
            <p>Each RP has exact origins and a write-only backend secret.</p>
          </div>
        </div>
        <div className="panel__body stack">
          <form className="set__inline" onSubmit={createApplication}>
            <label className="field set__inline-grow">
              <span>Name</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </label>
            <label className="field set__inline-grow">
              <span>RP ID</span>
              <input
                value={rpId}
                onChange={(event) => setRpId(event.target.value)}
                required
              />
            </label>
            <label className="field set__inline-grow">
              <span>Origin</span>
              <input
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Organization</span>
              <select
                value={organizationId}
                onChange={(event) => setOrganizationId(event.target.value)}
              >
                <option value="">Personal</option>
                {organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.displayName}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="button button--primary"
              disabled={busy}
            >
              Create
            </button>
          </form>
          {applications.length ? (
            <label className="field">
              <span>Manage application</span>
              <select
                value={selectedId}
                onChange={(event) => {
                  setSelectedId(event.target.value);
                  setApiSecret("");
                }}
              >
                {applications.map((application) => (
                  <option key={application.id} value={application.id}>
                    {application.displayName} · {application.rpId}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="muted">No applications yet.</p>
          )}
          {apiSecret ? (
            <div className="note note--warn">
              <strong>Copy now:</strong> <code>{apiSecret}</code>
            </div>
          ) : null}
          {selected ? (
            <div className="set__inline">
              <code>{selected.id}</code>
              <span className="muted">secret {selected.secretPrefix}…</span>
              <button
                type="button"
                className="button"
                onClick={() =>
                  void authenticationSectionSeams
                    .rotateAuthenticationApplicationSecret(selected.id)
                    .then((result) => {
                      setApiSecret(result.apiSecret);
                      setNotice({
                        tone: "ok",
                        text: "Secret rotated; the previous secret is invalid.",
                      });
                      void load();
                    })
                }
              >
                Rotate secret
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {selected ? (
        <>
          <section className="panel">
            <div className="panel__head">
              <div>
                <h2>Service settings</h2>
                <p>
                  Unlimited API keys and configurable sign-in or step-up
                  policies.
                </p>
              </div>
            </div>
            <div className="panel__body stack">
              <div className="set__inline">
                <label className="field">
                  <span>Application state</span>
                  <select
                    value={selected.state}
                    disabled={busy}
                    onChange={(event) => {
                      const state = applicationState(event.target.value);
                      if (state) void patchSelected({ state });
                    }}
                  >
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                    <option value="revoked">Revoked</option>
                  </select>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={selected.manualTokensEnabled}
                    disabled={busy}
                    onChange={(event) =>
                      void patchSelected({
                        manualTokensEnabled: event.target.checked,
                      })
                    }
                  />{" "}
                  Manual authentication tokens
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={selected.magicLinksEnabled}
                    disabled={busy}
                    onChange={(event) =>
                      void patchSelected({
                        magicLinksEnabled: event.target.checked,
                      })
                    }
                  />{" "}
                  Managed magic links
                </label>
              </div>
              <div className="stack">
                <strong>Backend API keys</strong>
                {selected.apiKeys.map((key) => (
                  <div key={key.id} className="set__inline">
                    <code>{key.secretPrefix}…</code>
                    <span className="muted">{key.state}</span>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        void authenticationSectionSeams
                          .updateAuthenticationApiKey(
                            selected.id,
                            key.id,
                            key.state === "active" ? "locked" : "active",
                          )
                          .then(load)
                      }
                    >
                      {key.state === "active" ? "Lock" : "Unlock"}
                    </button>
                    {key.state === "locked" ? (
                      <button
                        type="button"
                        className="button button--danger"
                        aria-label="Delete API key"
                        disabled={busy}
                        onClick={() =>
                          void authenticationSectionSeams
                            .deleteAuthenticationApiKey(selected.id, key.id)
                            .then(load)
                        }
                      >
                        <IconTrash size={15} />
                      </button>
                    ) : null}
                  </div>
                ))}
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void authenticationSectionSeams
                      .createAuthenticationApiKey(selected.id)
                      .then((result) => {
                        setApiSecret(result.apiKey.secret);
                        void load();
                        setNotice({
                          tone: "ok",
                          text: "API key created. Copy it now; only its hash is stored.",
                        });
                      })
                  }
                >
                  Create API key
                </button>
              </div>
              <div className="stack">
                <strong>Authentication configurations</strong>
                {selected.configurations.map((configuration) => (
                  <form
                    key={configuration.purpose}
                    className="set__inline"
                    onSubmit={(event) =>
                      void saveConfiguration(event, configuration.purpose)
                    }
                  >
                    <code>{configuration.purpose}</code>
                    <label className="field">
                      <span>TTL seconds</span>
                      <input
                        name="timeToLiveSeconds"
                        type="number"
                        min="1"
                        max="86400"
                        defaultValue={configuration.timeToLiveSeconds}
                        required
                      />
                    </label>
                    <label className="field">
                      <span>User verification</span>
                      <select
                        name="userVerification"
                        defaultValue={configuration.userVerification}
                      >
                        <option value="discouraged">Discouraged</option>
                        <option value="preferred">Preferred</option>
                        <option value="required">Required</option>
                      </select>
                    </label>
                    <button type="submit" className="button" disabled={busy}>
                      Save
                    </button>
                  </form>
                ))}
                <form
                  className="set__inline"
                  onSubmit={(event) => void addConfiguration(event)}
                >
                  <label className="field">
                    <span>New purpose</span>
                    <input
                      value={customPurpose}
                      pattern="[A-Za-z0-9_-]+"
                      maxLength={255}
                      onChange={(event) => setCustomPurpose(event.target.value)}
                    />
                  </label>
                  <button
                    type="submit"
                    className="button"
                    disabled={busy || !customPurpose}
                  >
                    Add policy
                  </button>
                </form>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel__head">
              <div>
                <h2>PWA ceremony</h2>
                <p>
                  Registration and sign-in run here only when this PWA origin is
                  registered for the RP. Other applications use the same SDK on
                  their own origin.
                </p>
              </div>
            </div>
            <div className="panel__body stack">
              {!canRunHere ? (
                <p className="note note--warn">
                  Open this client from one of{" "}
                  <code>{selected.origins.join(", ")}</code> to run its WebAuthn
                  ceremony. The admin console remains usable here.
                </p>
              ) : null}
              <form className="set__inline" onSubmit={register}>
                <label className="field">
                  <span>User name</span>
                  <input
                    value={userName}
                    onChange={(event) => setUserName(event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Alias</span>
                  <input
                    value={alias}
                    onChange={(event) => setAlias(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Passkey name</span>
                  <input
                    value={credentialName}
                    onChange={(event) => setCredentialName(event.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={busy || !canRunHere}
                >
                  <IconPasskey size={16} /> Register passkey
                </button>
              </form>
              <form className="set__inline" onSubmit={signIn}>
                <label className="field">
                  <span>Sign-in mode</span>
                  <select
                    value={signinMode}
                    onChange={(event) => {
                      const mode = authenticationMode(event.target.value);
                      if (mode) setSigninMode(mode);
                    }}
                  >
                    <option value="autofill">Conditional autofill</option>
                    <option value="discoverable">Discoverable prompt</option>
                    <option value="alias">Alias</option>
                    <option value="user_id">User ID</option>
                  </select>
                </label>
                {signinMode === "alias" || signinMode === "user_id" ? (
                  <label className="field">
                    <span>{signinMode === "alias" ? "Alias" : "User ID"}</span>
                    <input
                      value={signinValue}
                      onChange={(event) => setSigninValue(event.target.value)}
                      required
                    />
                  </label>
                ) : null}
                <label className="field">
                  <span>Purpose</span>
                  <select
                    value={signinPurpose}
                    onChange={(event) => setSigninPurpose(event.target.value)}
                  >
                    {selected.configurations.map((configuration) => (
                      <option
                        key={configuration.purpose}
                        value={configuration.purpose}
                      >
                        {configuration.purpose}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="submit"
                  className="button"
                  disabled={busy || !canRunHere}
                >
                  Sign in with passkey
                </button>
              </form>
            </div>
          </section>

          <section className="panel">
            <div className="panel__head">
              <div>
                <h2>Users and credentials</h2>
                <p>
                  Public keys only; private keys never leave authenticators.
                </p>
              </div>
            </div>
            <div className="panel__body stack">
              {users.length ? (
                users.map((user) => (
                  <div key={user.userId} className="cap-card">
                    <div>
                      <strong>{user.displayName}</strong>{" "}
                      <code>{user.userId}</code>
                      <p className="muted">
                        {user.aliases.join(", ") || "No aliases"}
                      </p>
                    </div>
                    {user.credentials.map((credential) => (
                      <div
                        key={credential.credentialId}
                        className="set__inline"
                      >
                        <IconPasskey size={16} />
                        <span>{credential.name ?? "Passkey"}</span>
                        <code>{credential.credentialId.slice(0, 18)}…</code>
                        <button
                          type="button"
                          className="button button--danger"
                          aria-label="Revoke credential"
                          onClick={() =>
                            void authenticationSectionSeams
                              .removeAuthenticationCredential(
                                selected.id,
                                credential.credentialId,
                              )
                              .then(loadDetails)
                          }
                        >
                          <IconTrash size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                ))
              ) : (
                <p className="muted">No registered users.</p>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel__head">
              <div>
                <h2>Event logs</h2>
                <p>
                  {events.length} app events
                  {selected.organizationId
                    ? ` · ${organizationEvents.length} organization events`
                    : ""}
                </p>
              </div>
            </div>
            <div className="panel__body stack">
              <strong>Application</strong>
              <ul className="cap-list">
                {events.slice(0, 20).map((event) => (
                  <li key={event.id} className="cap-card">
                    <strong>{event.eventType}</strong>
                    <span className="muted">
                      {new Date(event.occurredAt).toLocaleString()} ·{" "}
                      {event.outcome}
                    </span>
                  </li>
                ))}
              </ul>
              {selected.organizationId ? (
                <>
                  <strong>Organization</strong>
                  <ul className="cap-list">
                    {organizationEvents.slice(0, 20).map((event) => (
                      <li key={event.id} className="cap-card">
                        <strong>{event.eventType}</strong>
                        <span className="muted">
                          {new Date(event.occurredAt).toLocaleString()} ·{" "}
                          {event.outcome}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
