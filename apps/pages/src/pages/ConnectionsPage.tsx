import type { RevokeResponse } from "@opensesame/contracts";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconConnection, IconSearch } from "../components/Icons.js";
import {
  CatalogResponseError,
  type Connection,
  type Integration,
  type OrganizationMember,
  type Provider,
  type ProviderCategory,
  type ProviderConfigurationField,
  addMember,
  authorizeConnection,
  chooseOrganization,
  createConnection,
  createIntegration,
  deleteIntegration,
  listConnections,
  listIntegrations,
  listMembers,
  listProviders,
  refreshConnection,
  removeMember,
  revokeConnection,
  setConnectionConfiguration,
  updateIntegration,
  updateMember,
} from "../lib/connections.js";
import {
  type OrganizationRole,
  type SessionOrganization,
  clearHostSession,
  listSessionOrganizations,
} from "../lib/identity.js";
import { loadSettings } from "../lib/settings.js";

const CATEGORY_LABELS: Record<ProviderCategory, string> = {
  developer: "Developer tools",
  productivity: "Productivity",
  communication: "Communication",
  storage: "Storage",
  crm: "CRM",
  payments: "Payments",
  identity: "Identity",
  testing: "Testing",
};

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS) as ProviderCategory[];

type MarketplaceAuthFilter = "all" | Provider["authKind"];

export type ConnectionsLoadIssue = {
  kind: "identity" | "host" | "catalog";
  message: string;
};

function message(error: unknown) {
  return error instanceof Error ? error.message : "The request failed.";
}

export function filterProviders(
  providers: Provider[],
  query: string,
  category: string,
  authKind: MarketplaceAuthFilter = "all",
) {
  const needle = query.trim().toLowerCase();
  return providers.filter(
    (provider) =>
      (category === "all" || provider.category === category) &&
      (authKind === "all" || provider.authKind === authKind) &&
      (!needle ||
        provider.displayName.toLowerCase().includes(needle) ||
        provider.id.toLowerCase().includes(needle)),
  );
}

export function classifyConnectionsLoadIssue(
  error: unknown,
  source: "identity" | "host" = "host",
): ConnectionsLoadIssue {
  if (source === "identity")
    return { kind: "identity", message: message(error) };
  if (error instanceof CatalogResponseError) {
    return { kind: "catalog", message: error.message };
  }
  return { kind: "host", message: message(error) };
}

export function canConfigure(role: OrganizationRole) {
  return role === "owner" || role === "admin";
}

export function canSealProviderConfiguration(provider: Provider) {
  return !provider.missingConfig.includes("OPENSESAME_CONNECTION_KEY");
}

export function integrationConfigurationNotice(
  providerName: string,
  integration: Integration,
) {
  return integration.configured
    ? `${providerName} is ready for members to use.`
    : `${providerName} was saved, but the Host reports it is not ready. Complete Host configuration before members connect.`;
}

export async function loadCatalogBeforeWorkspace<T, U>(
  loadCatalog: () => Promise<T>,
  commitCatalog: (catalog: T) => void,
  loadWorkspace: () => Promise<U>,
) {
  const catalog = await loadCatalog();
  commitCatalog(catalog);
  return loadWorkspace();
}

export function reconcileOrganization(
  organizations: SessionOrganization[],
  currentId: string,
) {
  const organizationId = chooseOrganization(organizations, currentId);
  return {
    organizationId,
    organization:
      organizations.find((candidate) => candidate.id === organizationId) ??
      null,
  };
}

export function parseConnectionMessage(
  event: MessageEvent,
  hostOrigin: string,
) {
  if (
    event.origin !== hostOrigin ||
    !event.data ||
    typeof event.data !== "object" ||
    event.data.type !== "opensesame:connection"
  ) {
    return null;
  }
  const status =
    typeof event.data.status === "string" ? event.data.status : null;
  const error = typeof event.data.error === "string" ? event.data.error : null;
  if (!status && !error) return null;
  return {
    status,
    error,
    hint: typeof event.data.hint === "string" ? event.data.hint : null,
  };
}

export const CONNECTION_POLL_MAX_ATTEMPTS = 40;
const CONNECTION_POLL_INTERVAL_MS = 3_000;

export function shouldPollPendingConnections(
  connections: Array<Pick<Connection, "status">>,
  attempts: number,
) {
  return (
    attempts < CONNECTION_POLL_MAX_ATTEMPTS &&
    connections.some((connection) => connection.status === "pending")
  );
}

/** Read a credential-bearing form once, then clear its live DOM immediately. */
export function takeSensitiveFormData(form: HTMLFormElement) {
  const data = new FormData(form);
  form.reset();
  return data;
}

const CONFIGURATION_FIELD_LABELS: Record<string, string> = {
  api_key: "API key",
  client_id: "Client ID",
  client_secret: "Client secret",
};

export function configurationFieldLabel(name: string) {
  return (
    CONFIGURATION_FIELD_LABELS[name] ??
    name
      .split(/[._-]+/u)
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" ")
  );
}

function configurationInputName(name: string) {
  return `configuration.${name}`;
}

export function configurationFromFormData(
  data: FormData,
  fields: ProviderConfigurationField[],
) {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const raw = String(data.get(configurationInputName(field.name)) ?? "");
      const value = field.secret ? raw : raw.trim();
      return value ? [[field.name, value]] : [];
    }),
  );
}

export function configurationClearFromFormData(
  data: FormData,
  fields: ProviderConfigurationField[],
) {
  const allowed = new Set(fields.map((field) => field.name));
  return data
    .getAll("configuration_clear")
    .map(String)
    .filter((name) => allowed.has(name));
}

/** Keep a successfully created Pending row visible when its next step fails. */
export async function recoverCreatedConnection<T>(
  finish: () => Promise<T>,
  reload: () => Promise<void>,
) {
  try {
    return await finish();
  } catch (caught) {
    try {
      await reload();
    } catch {
      // The completion error is the actionable failure; never replace it with a
      // secondary refresh error.
    }
    throw caught;
  }
}

export function runConfirmedAction(
  prompt: string,
  action: () => void,
  confirm: (message: string) => boolean = (message) => window.confirm(message),
) {
  if (!confirm(prompt)) return false;
  action();
  return true;
}

export function connectionRevocationNotice(
  connectionName: string,
  providerName: string,
  result: RevokeResponse,
) {
  if (!result.revoked) {
    return `${connectionName} revocation was not confirmed locally. Check the connection and revoke access in ${providerName}.`;
  }
  if (result.provider_revocation === "ok") {
    return `${connectionName} revoked locally and at ${providerName}.`;
  }
  if (result.provider_revocation === "failed") {
    return `${connectionName} revoked locally, but automatic provider revocation failed. The upstream grant may remain; revoke access in ${providerName}.`;
  }
  return `${connectionName} revoked locally, but ${providerName} does not support automatic revocation. The upstream grant may remain; revoke access in ${providerName}.`;
}

export async function loadOptionalMembers(
  role: OrganizationRole,
  load: () => Promise<OrganizationMember[]>,
) {
  if (role !== "owner") return { members: [], failed: false };
  try {
    return { members: await load(), failed: false };
  } catch {
    return { members: [], failed: true };
  }
}

export function ConnectionsPage() {
  const [organizations, setOrganizations] = useState<SessionOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [membersFailed, setMembersFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadIssue, setLoadIssue] = useState<ConnectionsLoadIssue | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeOrganizationId = useRef<string | null>(null);

  const organization =
    organizations.find((candidate) => candidate.id === organizationId) ?? null;

  const loadWorkspace = useCallback(async (selected: SessionOrganization) => {
    setLoading(true);
    setLoadIssue(null);
    try {
      const [nextIntegrations, nextConnections, memberLoad] =
        await loadCatalogBeforeWorkspace(
          () => listProviders(selected.id),
          (nextProviders) => {
            if (activeOrganizationId.current === selected.id) {
              setProviders(nextProviders);
            }
          },
          () =>
            Promise.all([
              listIntegrations(selected.id),
              listConnections(selected.id),
              loadOptionalMembers(selected.role, () =>
                listMembers(selected.id),
              ),
            ]),
        );
      if (activeOrganizationId.current !== selected.id) return;
      setIntegrations(nextIntegrations);
      setConnections(nextConnections);
      setMembers(memberLoad.members);
      setMembersFailed(memberLoad.failed);
      setLoadIssue(null);
      setError(null);
    } catch (caught) {
      if (activeOrganizationId.current === selected.id) {
        setLoadIssue(classifyConnectionsLoadIssue(caught));
      }
    } finally {
      if (activeOrganizationId.current === selected.id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    void listSessionOrganizations()
      .then((next) => {
        if (!current) return;
        setOrganizations(next);
        setOrganizationId((selected) => chooseOrganization(next, selected));
        setLoadIssue(
          next.length
            ? null
            : {
                kind: "identity",
                message: "This Identity session has no organizations.",
              },
        );
        setError(null);
      })
      .catch((caught) => {
        if (current) {
          setLoadIssue(classifyConnectionsLoadIssue(caught, "identity"));
          setError(null);
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    activeOrganizationId.current = organization?.id ?? null;
    if (organization) void loadWorkspace(organization);
  }, [organization, loadWorkspace]);

  useEffect(() => {
    if (!organization) return;
    const selectedOrganization = organization;
    const hostOrigin = new URL(loadSettings().hostApi).origin;
    function onMessage(event: MessageEvent) {
      const result = parseConnectionMessage(event, hostOrigin);
      if (!result) return;
      if (result.error) {
        setNotice(null);
        const callbackError = result.hint ?? result.error;
        void loadWorkspace(selectedOrganization).then(() =>
          setError(callbackError),
        );
      } else {
        setError(null);
        setNotice("Connection authorized.");
        void loadWorkspace(selectedOrganization);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [organization, loadWorkspace]);

  const hasPendingConnections = shouldPollPendingConnections(connections, 0);
  useEffect(() => {
    if (!organization || !hasPendingConnections) return;
    const selectedOrganization = organization;
    let attempts = 0;
    let cancelled = false;
    let timer: number;
    function schedule() {
      timer = window.setTimeout(() => {
        attempts += 1;
        void listConnections(selectedOrganization.id)
          .then((nextConnections) => {
            if (activeOrganizationId.current === selectedOrganization.id) {
              setConnections(nextConnections);
              setError(null);
            }
          })
          .catch((caught) => {
            if (activeOrganizationId.current === selectedOrganization.id) {
              setError(message(caught));
            }
          })
          .finally(() => {
            if (!cancelled && attempts < CONNECTION_POLL_MAX_ATTEMPTS) {
              schedule();
            }
          });
      }, CONNECTION_POLL_INTERVAL_MS);
    }
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [organization, hasPendingConnections]);

  function switchOrganization(nextId: string) {
    activeOrganizationId.current = nextId || null;
    clearHostSession();
    setOrganizationId(nextId || null);
    setProviders(null);
    setIntegrations([]);
    setConnections([]);
    setMembers([]);
    setNotice(null);
    setError(null);
    setLoadIssue(null);
  }

  async function act(
    label: string,
    work: () => Promise<void>,
    refreshMembership = false,
  ) {
    if (!organization) return;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await work();
      let selected: SessionOrganization | null = organization;
      if (refreshMembership) {
        const nextOrganizations = await listSessionOrganizations();
        const refreshed = reconcileOrganization(
          nextOrganizations,
          organization.id,
        );
        selected = refreshed.organization;
        clearHostSession();
        activeOrganizationId.current = refreshed.organizationId;
        setOrganizations(nextOrganizations);
        setOrganizationId(refreshed.organizationId);
        if (!selected) {
          setProviders(null);
          setIntegrations([]);
          setConnections([]);
          setMembers([]);
          setMembersFailed(false);
          setLoading(false);
        }
      }
      if (selected && !refreshMembership) await loadWorkspace(selected);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="connections-page">
      <header className="connections-head">
        <div>
          <h1>Connections</h1>
          <p>
            Configure an integration once, then let members authorize their own
            accounts without revealing OAuth secrets to the browser or agents.
          </p>
        </div>
        {organizations.length > 1 ? (
          <label className="organization-picker" htmlFor="organization">
            Organization
            <select
              id="organization"
              value={organizationId ?? ""}
              onChange={(event) => switchOrganization(event.target.value)}
              disabled={busy !== null}
            >
              <option value="">Select organization</option>
              {organizations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName} · {item.role}
                </option>
              ))}
            </select>
          </label>
        ) : organization ? (
          <p className="organization-current">
            <span>Organization</span>
            <strong>{organization.displayName}</strong> · {organization.role}
          </p>
        ) : null}
      </header>

      {organization ? (
        <nav className="connections-jump" aria-label="Connections sections">
          <a href="#marketplace">Marketplace</a>
          <a href="#my-connections">My connections</a>
          <a href="#configured-connectors">Configured connectors</a>
          {organization.role === "owner" ? (
            <a href="#organization-access">Organization access</a>
          ) : null}
        </nav>
      ) : null}

      {error ? (
        <p className="err connections-alert" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <output className="ok connections-alert">{notice}</output>
      ) : null}
      {organization ? (
        <>
          <MarketplacePanel
            providers={providers}
            integrations={integrations}
            accessRole={organization.role}
            busy={busy}
            loading={loading}
            loadIssue={loadIssue}
            onRetry={() => void loadWorkspace(organization)}
            onConfigure={(provider, form) =>
              act(`configure-${provider.id}`, async () => {
                const integration = await createIntegration(
                  organization.id,
                  form,
                );
                setNotice(
                  integrationConfigurationNotice(
                    provider.displayName,
                    integration,
                  ),
                );
              })
            }
            onConnect={(provider, integration, form, popup) =>
              act(`connect-${integration.id}`, async () => {
                const connection = await createConnection(organization.id, {
                  integrationId: integration.id,
                  displayName: form.displayName,
                  scopes: integration.scopes,
                });
                await recoverCreatedConnection(
                  async () => {
                    if (Object.keys(form.configuration).length > 0) {
                      await setConnectionConfiguration(
                        organization.id,
                        connection.id,
                        form.configuration,
                      );
                      setNotice(
                        "Connection credentials sealed. Their values will not be shown again.",
                      );
                      return;
                    }
                    const authorizationUrl = await authorizeConnection(
                      organization.id,
                      connection.id,
                    );
                    if (popup) popup.location.href = authorizationUrl;
                    else window.location.assign(authorizationUrl);
                    setNotice("Provider authorization opened in a new window.");
                  },
                  async () => {
                    popup?.close();
                    await loadWorkspace(organization);
                  },
                );
              })
            }
          />

          {providers ? (
            <>
              <ConnectionsPanel
                connections={connections}
                integrations={integrations}
                providers={providers}
                busy={busy}
                onRefresh={(connection) =>
                  act(`refresh-${connection.id}`, async () => {
                    await refreshConnection(organization.id, connection.id);
                    setNotice(`${connection.displayName} refreshed.`);
                  })
                }
                onReauthorize={(connection, popup) =>
                  act(`reauthorize-${connection.id}`, async () => {
                    try {
                      const authorizationUrl = await authorizeConnection(
                        organization.id,
                        connection.id,
                      );
                      if (popup) popup.location.href = authorizationUrl;
                      else window.location.assign(authorizationUrl);
                      setNotice(
                        "Provider authorization opened in a new window.",
                      );
                    } catch (caught) {
                      popup?.close();
                      throw caught;
                    }
                  })
                }
                onConfiguration={(connection, set, clear) =>
                  act(`credential-${connection.id}`, async () => {
                    await setConnectionConfiguration(
                      organization.id,
                      connection.id,
                      set,
                      clear,
                    );
                    setNotice(`${connection.displayName} credentials updated.`);
                  })
                }
                onRevoke={(connection) =>
                  runConfirmedAction(
                    `Revoke ${connection.displayName}? This connection will stop working immediately.`,
                    () =>
                      void act(`revoke-${connection.id}`, async () => {
                        const result = await revokeConnection(
                          organization.id,
                          connection.id,
                        );
                        const providerName =
                          providers.find(
                            (provider) => provider.id === connection.providerId,
                          )?.displayName ?? "the provider";
                        setNotice(
                          connectionRevocationNotice(
                            connection.displayName,
                            providerName,
                            result,
                          ),
                        );
                      }),
                  )
                }
              />

              <IntegrationsPanel
                integrations={integrations}
                providers={providers}
                accessRole={organization.role}
                busy={busy}
                onToggle={(integration) =>
                  act(`toggle-${integration.id}`, async () => {
                    await updateIntegration(organization.id, integration.id, {
                      enabled: !integration.enabled,
                    });
                    setNotice(
                      `${integration.displayName} ${integration.enabled ? "disabled" : "enabled"}.`,
                    );
                  })
                }
                onConfiguration={(integration, set, clear) =>
                  act(`rotate-${integration.id}`, async () => {
                    await updateIntegration(organization.id, integration.id, {
                      configuration_set: set,
                      configuration_clear: clear,
                    });
                    setNotice(
                      `${integration.displayName} configuration updated.`,
                    );
                  })
                }
                onDelete={(integration) =>
                  act(`delete-${integration.id}`, async () => {
                    await deleteIntegration(organization.id, integration.id);
                    setNotice(`${integration.displayName} deleted.`);
                  })
                }
              />

              {organization.role === "owner" ? (
                <OrganizationAccessPanel
                  members={members}
                  failed={membersFailed}
                  busy={busy}
                  onRetry={() => void loadWorkspace(organization)}
                  onAdd={(principalId, role) =>
                    act("add-member", async () => {
                      await addMember(organization.id, principalId, role);
                      setNotice(`${principalId} added as ${role}.`);
                    })
                  }
                  onRole={(principalId, role) =>
                    act(
                      `role-${principalId}`,
                      async () => {
                        await updateMember(organization.id, principalId, role);
                        setNotice(`${principalId} is now ${role}.`);
                      },
                      true,
                    )
                  }
                  onRemove={(principalId) =>
                    runConfirmedAction(
                      `Remove ${principalId} from this organization? Their Host sessions will be revoked.`,
                      () =>
                        void act(
                          `remove-${principalId}`,
                          async () => {
                            await removeMember(organization.id, principalId);
                            setNotice(
                              `${principalId} removed from the organization.`,
                            );
                          },
                          true,
                        ),
                    )
                  }
                />
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <ConnectionsGate
          loading={loading}
          issue={loadIssue}
          hasOrganizations={organizations.length > 0}
          onRetry={() => window.location.reload()}
        />
      )}
    </div>
  );
}

export function ConnectionsGate({
  loading,
  issue,
  hasOrganizations,
  onRetry,
}: {
  loading: boolean;
  issue: ConnectionsLoadIssue | null;
  hasOrganizations: boolean;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <MarketplaceState
        title="Checking your Identity session"
        detail="Reading the organizations this browser is allowed to manage."
        loading
      />
    );
  }
  if (hasOrganizations) {
    return (
      <MarketplaceState
        title="Choose an organization"
        detail="Select an organization above to load its Host catalog, integrations, and member connections."
      />
    );
  }
  return (
    <MarketplaceState
      title="Identity access required"
      detail={
        issue?.message ??
        "Sign in to Identity with access to an organization, then try again."
      }
      tone="error"
      actionLabel="Retry Identity"
      onAction={onRetry}
    />
  );
}

export function MarketplacePanel({
  providers,
  integrations,
  accessRole,
  busy,
  loading,
  loadIssue,
  onRetry,
  onConfigure,
  onConnect,
}: {
  providers: Provider[] | null;
  integrations: Integration[];
  accessRole: OrganizationRole;
  busy: string | null;
  loading: boolean;
  loadIssue: ConnectionsLoadIssue | null;
  onRetry: () => void;
  onConfigure: (
    provider: Provider,
    form: {
      key: string;
      providerId: string;
      displayName: string;
      configuration: Record<string, string>;
      scopes: string[];
    },
  ) => void;
  onConnect: (
    provider: Provider,
    integration: Integration,
    form: { displayName: string; configuration: Record<string, string> },
    popup: Window | null,
  ) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [authKind, setAuthKind] = useState<MarketplaceAuthFilter>("all");
  const visible = useMemo(
    () => filterProviders(providers ?? [], query, category, authKind),
    [providers, query, category, authKind],
  );
  const categories = CATEGORY_ORDER.filter((item) =>
    providers?.some((provider) => provider.category === item),
  );
  const hasFilters =
    Boolean(query.trim()) || category !== "all" || authKind !== "all";
  const total = providers?.length ?? null;
  const emptyCopy = marketplaceEmptyCopy(hasFilters);

  function clearFilters() {
    setQuery("");
    setCategory("all");
    setAuthKind("all");
  }

  return (
    <section
      className="connections-section"
      id="marketplace"
      aria-busy={loading || undefined}
    >
      <div className="connections-section-head">
        <div>
          <h2>Marketplace</h2>
          <p>Bundled provider templates available on this Host deployment.</p>
        </div>
        <p className="marketplace-total">
          {total === null
            ? "Catalog pending"
            : `${total} connector${total === 1 ? "" : "s"}`}
        </p>
      </div>
      {providers ? (
        <div className="marketplace-filters" aria-label="Filter connectors">
          <label className="marketplace-search">
            <span>Search</span>
            <span className="marketplace-search-control">
              <IconSearch />
              <input
                type="search"
                placeholder="Name or provider ID"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </span>
          </label>
          <label>
            <span>Category</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="all">All categories</option>
              {categories.map((item) => (
                <option key={item} value={item}>
                  {CATEGORY_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Authentication</span>
            <select
              value={authKind}
              onChange={(event) =>
                setAuthKind(event.target.value as MarketplaceAuthFilter)
              }
            >
              <option value="all">All methods</option>
              <option value="oauth2_authorization_code">OAuth 2.0</option>
              <option value="api_key">API key</option>
              <option value="configuration">Configuration</option>
            </select>
          </label>
        </div>
      ) : null}
      {providers ? (
        <output className="marketplace-results" aria-live="polite">
          {loading
            ? "Refreshing connector catalog…"
            : `Showing ${visible.length} of ${providers.length} connectors`}
        </output>
      ) : null}
      {loadIssue && providers ? (
        <MarketplaceState
          title={
            loadIssue.kind === "catalog"
              ? "Catalog refresh failed"
              : loadIssue.kind === "identity"
                ? "Identity data refresh failed"
                : "Host refresh failed"
          }
          detail={`${loadIssue.message} The last verified workspace remains visible.`}
          tone="error"
          actionLabel="Retry"
          onAction={onRetry}
          actionDisabled={loading}
        />
      ) : null}
      {providers === null ? (
        <MarketplaceState
          title={
            loading
              ? "Loading provider catalog"
              : loadIssue?.kind === "catalog"
                ? "Provider catalog unavailable"
                : "Host unavailable"
          }
          detail={
            loading
              ? "Authorizing with Host and reading its bundled provider templates."
              : (loadIssue?.message ??
                "The Host catalog could not be read. Check the Host address under Settings.")
          }
          tone={loading ? "neutral" : "error"}
          loading={loading}
          actionLabel={loading ? undefined : "Retry catalog"}
          onAction={loading ? undefined : onRetry}
        />
      ) : providers.length === 0 ? (
        <MarketplaceState
          title="Provider catalog is empty"
          detail="No provider templates were returned. Verify the Host deployment instead of treating this as an empty marketplace."
          tone="error"
          actionLabel="Retry catalog"
          onAction={onRetry}
        />
      ) : visible.length ? (
        <ul className="provider-grid">
          {visible.map((provider) => {
            const canSeal = canSealProviderConfiguration(provider);
            const available = integrations.filter(
              (integration) =>
                integration.providerId === provider.id &&
                integration.configured &&
                integration.enabled,
            );
            return (
              <li key={provider.id} className="provider-tile">
                <div className="provider-title">
                  <span className="type-badge">
                    <IconConnection />
                  </span>
                  <div>
                    <h3>{provider.displayName}</h3>
                    <p>{CATEGORY_LABELS[provider.category]}</p>
                  </div>
                </div>
                <p className="provider-state">
                  {available.length
                    ? `${available.length} integration${available.length === 1 ? "" : "s"} available`
                    : "No enabled integration"}
                </p>
                {available.map((integration) => (
                  <details key={integration.id} className="inline-action">
                    <summary>Connect with {integration.displayName}</summary>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = takeSensitiveFormData(event.currentTarget);
                        const popup =
                          provider.authKind === "oauth2_authorization_code"
                            ? window.open(
                                "about:blank",
                                "opensesame-provider-consent",
                                "popup,width=620,height=760",
                              )
                            : null;
                        onConnect(
                          provider,
                          integration,
                          {
                            displayName:
                              String(data.get("displayName") ?? "").trim() ||
                              `${provider.displayName} connection`,
                            configuration: configurationFromFormData(
                              data,
                              provider.connectionConfigurationFields,
                            ),
                          },
                          popup,
                        );
                      }}
                    >
                      <label>
                        Connection name
                        <input
                          name="displayName"
                          defaultValue={`${provider.displayName} connection`}
                          required
                        />
                      </label>
                      {provider.connectionConfigurationFields.map((field) => (
                        <label key={field.name}>
                          {configurationFieldLabel(field.name)}
                          <input
                            name={configurationInputName(field.name)}
                            type={field.secret ? "password" : "text"}
                            autoComplete={field.secret ? "new-password" : "off"}
                            maxLength={8 * 1024}
                            required={field.required}
                          />
                        </label>
                      ))}
                      <button
                        type="submit"
                        className="primary compact"
                        disabled={busy !== null}
                      >
                        {provider.connectionConfigurationFields.length > 0
                          ? "Seal credentials"
                          : "Authorize account"}
                      </button>
                    </form>
                  </details>
                ))}
                {canConfigure(accessRole) && canSeal ? (
                  <ConfigureIntegration
                    provider={provider}
                    integrations={integrations.filter(
                      (integration) => integration.providerId === provider.id,
                    )}
                    busy={busy !== null}
                    onSubmit={onConfigure}
                  />
                ) : canConfigure(accessRole) ? (
                  <p className="provider-help">
                    Host sealing is unavailable. Set OPENSESAME_CONNECTION_KEY
                    before configuring this connector.
                  </p>
                ) : available.length === 0 ? (
                  <p className="provider-help">
                    Ask an owner or admin to configure this provider.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <MarketplaceState
          title={emptyCopy.title}
          detail={emptyCopy.detail}
          actionLabel={hasFilters ? "Clear filters" : undefined}
          onAction={hasFilters ? clearFilters : undefined}
        />
      )}
    </section>
  );
}

export function marketplaceEmptyCopy(hasFilters: boolean) {
  return hasFilters
    ? {
        title: "No matching connectors",
        detail:
          "No connector matches the current search, category, and authentication filters.",
      }
    : {
        title: "No connectors available",
        detail: "No connector is available for this view.",
      };
}

function MarketplaceState({
  title,
  detail,
  tone = "neutral",
  loading = false,
  actionLabel,
  onAction,
  actionDisabled = false,
}: {
  title: string;
  detail: string;
  tone?: "neutral" | "error";
  loading?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}) {
  return (
    <div
      className={`marketplace-state${tone === "error" ? " is-error" : ""}`}
      role={tone === "error" ? "alert" : "status"}
      aria-busy={loading || undefined}
    >
      <span className="type-badge" aria-hidden="true">
        <IconConnection />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
      {actionLabel && onAction ? (
        <button
          type="button"
          className="compact"
          onClick={onAction}
          disabled={actionDisabled}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function ConfigureIntegration({
  provider,
  integrations,
  busy,
  onSubmit,
}: {
  provider: Provider;
  integrations: Integration[];
  busy: boolean;
  onSubmit: MarketplacePanelProps["onConfigure"];
}) {
  return (
    <details className="inline-action">
      <summary>Configure integration</summary>
      {provider.authKind === "oauth2_authorization_code" ? (
        provider.callbackUrl ? (
          <CallbackUrl url={provider.callbackUrl} />
        ) : (
          integrations.map((integration) =>
            integration.callbackUrl ? (
              <CallbackUrl key={integration.id} url={integration.callbackUrl} />
            ) : null,
          )
        )
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = takeSensitiveFormData(event.currentTarget);
          onSubmit(provider, {
            key: String(data.get("key") ?? "").trim(),
            providerId: provider.id,
            displayName: String(data.get("displayName") ?? "").trim(),
            configuration: configurationFromFormData(
              data,
              provider.integrationConfigurationFields,
            ),
            scopes: data.getAll("scopes").map(String),
          });
        }}
      >
        <div className="form-grid">
          <label>
            Name
            <input
              name="displayName"
              defaultValue={`${provider.displayName} primary`}
              required
            />
          </label>
          <label>
            Key
            <input
              name="key"
              defaultValue={`${provider.id}-primary`}
              required
            />
          </label>
          {provider.integrationConfigurationFields.map((field) => (
            <label key={field.name}>
              {configurationFieldLabel(field.name)}
              <input
                name={configurationInputName(field.name)}
                type={field.secret ? "password" : "text"}
                autoComplete={field.secret ? "new-password" : "off"}
                maxLength={8 * 1024}
                required={field.required}
              />
            </label>
          ))}
        </div>
        {provider.scopes.length ? (
          <fieldset className="scope-picker">
            <legend>Allowed scopes</legend>
            {provider.scopes.map((scope) => (
              <label key={scope.name} className="scope-option">
                <input
                  type="checkbox"
                  name="scopes"
                  value={scope.name}
                  defaultChecked={scope.default}
                />
                <span>
                  <code>{scope.name}</code>
                  <small>{scope.description}</small>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <button type="submit" className="primary compact" disabled={busy}>
          Save integration
        </button>
      </form>
    </details>
  );
}

type MarketplacePanelProps = Parameters<typeof MarketplacePanel>[0];

function CallbackUrl({ url }: { url: string }) {
  return (
    <div className="callback-url">
      <span>OAuth callback URL</span>
      <code>{url}</code>
      <button
        type="button"
        className="compact"
        onClick={() => void navigator.clipboard.writeText(url)}
      >
        Copy
      </button>
    </div>
  );
}

function ConfigurationUpdateForm({
  summary,
  fields,
  configuredFields,
  busy,
  onSubmit,
}: {
  summary: string;
  fields: ProviderConfigurationField[];
  configuredFields: Integration["configuredFields"];
  busy: boolean;
  onSubmit: (set: Record<string, string>, clear: string[]) => void;
}) {
  const configured = new Map(
    configuredFields.map((field) => [field.name, field]),
  );
  return (
    <details className="inline-action">
      <summary>{summary}</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = takeSensitiveFormData(event.currentTarget);
          const clear = configurationClearFromFormData(data, fields);
          const set = configurationFromFormData(data, fields);
          for (const name of clear) delete set[name];
          if (Object.keys(set).length > 0 || clear.length > 0) {
            onSubmit(set, clear);
          }
        }}
      >
        <div className="form-grid">
          {fields.map((field) => {
            const current = configured.get(field.name);
            const label = configurationFieldLabel(field.name);
            return (
              <div key={field.name} className="configuration-field">
                <label>
                  New {label}
                  {current ? (
                    <small>Currently {current.hint ?? "configured"}</small>
                  ) : null}
                  <input
                    name={configurationInputName(field.name)}
                    type={field.secret ? "password" : "text"}
                    autoComplete={field.secret ? "new-password" : "off"}
                    maxLength={8 * 1024}
                  />
                </label>
                {current ? (
                  <label className="scope-option">
                    <input
                      type="checkbox"
                      name="configuration_clear"
                      value={field.name}
                    />
                    <span>Clear stored {label}</span>
                  </label>
                ) : null}
              </div>
            );
          })}
        </div>
        <p className="provider-help">
          Enter a replacement or explicitly clear a stored field.
        </p>
        <button type="submit" className="primary compact" disabled={busy}>
          Save configuration
        </button>
      </form>
    </details>
  );
}

export function ConnectionsPanel({
  connections,
  integrations,
  providers,
  busy,
  onRefresh,
  onReauthorize,
  onConfiguration,
  onRevoke,
}: {
  connections: Connection[];
  integrations: Integration[];
  providers: Provider[];
  busy: string | null;
  onRefresh: (connection: Connection) => void;
  onReauthorize: (connection: Connection, popup: Window | null) => void;
  onConfiguration: (
    connection: Connection,
    set: Record<string, string>,
    clear: string[],
  ) => void;
  onRevoke: (connection: Connection) => void;
}) {
  const integrationNames = new Map(
    integrations.map((integration) => [
      integration.id,
      integration.displayName,
    ]),
  );
  const providersById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  return (
    <section className="connections-section" id="my-connections">
      <div className="connections-section-head">
        <div>
          <h2>My connections</h2>
          <p>Accounts you authorized through organization integrations.</p>
        </div>
      </div>
      {connections.length ? (
        <ul className="connection-list">
          {connections.map((connection) => (
            <li key={connection.id}>
              <div>
                <strong>{connection.displayName}</strong>
                <span>
                  {(connection.integrationId
                    ? integrationNames.get(connection.integrationId)
                    : null) ?? connection.providerId}
                </span>
              </div>
              <div className="connection-meta">
                <span className={`connection-status is-${connection.status}`}>
                  {connection.status.replaceAll("_", " ")}
                </span>
                {connection.accountLabel ? (
                  <span>{connection.accountLabel}</span>
                ) : null}
              </div>
              <div className="connection-actions">
                {connection.refreshable ? (
                  <button
                    type="button"
                    className="compact"
                    disabled={busy !== null}
                    onClick={() => onRefresh(connection)}
                  >
                    Refresh
                  </button>
                ) : null}
                {(providersById.get(connection.providerId)
                  ?.connectionConfigurationFields.length ?? 0) > 0 ? (
                  <ConfigurationUpdateForm
                    summary="Update credentials"
                    fields={
                      providersById.get(connection.providerId)
                        ?.connectionConfigurationFields ?? []
                    }
                    configuredFields={connection.configuredFields}
                    busy={busy !== null}
                    onSubmit={(set, clear) =>
                      onConfiguration(connection, set, clear)
                    }
                  />
                ) : providersById.get(connection.providerId)?.authKind ===
                  "oauth2_authorization_code" ? (
                  <button
                    type="button"
                    className="compact"
                    disabled={busy !== null}
                    onClick={() =>
                      onReauthorize(
                        connection,
                        window.open(
                          "about:blank",
                          "opensesame-provider-consent",
                          "popup,width=620,height=760",
                        ),
                      )
                    }
                  >
                    Reauthorize
                  </button>
                ) : null}
                <button
                  type="button"
                  className="danger compact"
                  disabled={busy !== null}
                  onClick={() => onRevoke(connection)}
                >
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No accounts connected yet.</p>
      )}
    </section>
  );
}

export function IntegrationsPanel({
  integrations,
  providers,
  accessRole,
  busy,
  onToggle,
  onConfiguration,
  onDelete,
}: {
  integrations: Integration[];
  providers: Provider[];
  accessRole: OrganizationRole;
  busy: string | null;
  onToggle: (integration: Integration) => void;
  onConfiguration: (
    integration: Integration,
    set: Record<string, string>,
    clear: string[],
  ) => void;
  onDelete: (integration: Integration) => void;
}) {
  const manage = canConfigure(accessRole);
  const providersById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  return (
    <section className="connections-section" id="configured-connectors">
      <div className="connections-section-head">
        <div>
          <h2>Configured connectors</h2>
          <p>
            Connector configuration is organization-wide. Secret values are
            never returned.
          </p>
        </div>
        <span className="role-chip">{accessRole} access</span>
      </div>
      {integrations.length ? (
        <ul className="integration-list">
          {integrations.map((integration) => (
            <li key={integration.id}>
              <div className="integration-summary">
                <div>
                  <strong>{integration.displayName}</strong>
                  <span>
                    {integration.providerId} · {integration.key} ·{" "}
                    {integration.source === "shared_dev"
                      ? "Development only"
                      : integration.source === "deployment"
                        ? "Deployment"
                        : "Organization"}
                  </span>
                </div>
                <span
                  className={`connection-status ${integration.enabled ? "is-active" : ""}`}
                >
                  {integration.enabled ? "enabled" : "disabled"}
                </span>
              </div>
              <dl className="integration-facts">
                {integration.configuredFields.map((field) => (
                  <div key={field.name}>
                    <dt>{configurationFieldLabel(field.name)}</dt>
                    <dd>{field.hint ?? "Configured"}</dd>
                  </div>
                ))}
                <div>
                  <dt>Connections</dt>
                  <dd>{integration.connectionCount}</dd>
                </div>
                <div>
                  <dt>Scopes</dt>
                  <dd>{integration.scopes.join(", ") || "None"}</dd>
                </div>
              </dl>
              {integration.callbackUrl ? (
                <CallbackUrl url={integration.callbackUrl} />
              ) : null}
              {manage && integration.source === "organization" ? (
                <div className="integration-actions">
                  <button
                    type="button"
                    className="compact"
                    disabled={busy !== null}
                    onClick={() => onToggle(integration)}
                  >
                    {integration.enabled ? "Disable" : "Enable"}
                  </button>
                  {(providersById.get(integration.providerId)
                    ?.integrationConfigurationFields.length ?? 0) > 0 ? (
                    <ConfigurationUpdateForm
                      summary="Update configuration"
                      fields={
                        providersById.get(integration.providerId)
                          ?.integrationConfigurationFields ?? []
                      }
                      configuredFields={integration.configuredFields}
                      busy={busy !== null}
                      onSubmit={(set, clear) =>
                        onConfiguration(integration, set, clear)
                      }
                    />
                  ) : null}
                  <details className="inline-action danger-action">
                    <summary>Delete</summary>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        if (data.get("confirm") === integration.displayName)
                          onDelete(integration);
                      }}
                    >
                      <p>
                        Type <strong>{integration.displayName}</strong> to
                        delete it. Existing connections must be removed first.
                      </p>
                      <label>
                        Integration name
                        <input
                          name="confirm"
                          required
                          pattern={integration.displayName.replace(
                            /[.*+?^${}()|[\]\\]/g,
                            "\\$&",
                          )}
                        />
                      </label>
                      <button
                        type="submit"
                        className="danger compact"
                        disabled={busy !== null}
                      >
                        Delete integration
                      </button>
                    </form>
                  </details>
                </div>
              ) : (
                <p className="provider-help">
                  {integration.source === "organization"
                    ? "Configuration is read-only for members."
                    : "This deployment-managed integration is read-only."}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No connectors configured.</p>
      )}
    </section>
  );
}

function OrganizationAccessPanel({
  members,
  failed,
  busy,
  onRetry,
  onAdd,
  onRole,
  onRemove,
}: {
  members: OrganizationMember[];
  failed: boolean;
  busy: string | null;
  onRetry: () => void;
  onAdd: (principalId: string, role: OrganizationRole) => void;
  onRole: (principalId: string, role: OrganizationRole) => void;
  onRemove: (principalId: string) => void;
}) {
  return (
    <section className="connections-section" id="organization-access">
      <div className="connections-section-head">
        <div>
          <h2>Organization access</h2>
          <p>Owners can add an existing principal ID and manage its role.</p>
        </div>
      </div>
      {failed ? (
        <p className="err connections-alert" role="alert">
          Organization members are unavailable. Marketplace and connections
          remain available.{" "}
          <button type="button" className="compact" onClick={onRetry}>
            Retry access
          </button>
        </p>
      ) : null}
      <form
        className="member-add"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onAdd(
            String(data.get("principalId") ?? "").trim(),
            String(data.get("role")) as OrganizationRole,
          );
          event.currentTarget.reset();
        }}
      >
        <label>
          Existing principal ID
          <input name="principalId" required placeholder="prn_…" />
        </label>
        <label>
          Role
          <select name="role" defaultValue="member">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        <button type="submit" className="primary" disabled={busy !== null}>
          Add principal
        </button>
      </form>
      <ul className="member-list">
        {members.map((member) => (
          <li key={member.principalId}>
            <code>{member.principalId}</code>
            <label>
              <span className="sr-only">Role for {member.principalId}</span>
              <select
                value={member.role}
                disabled={busy !== null}
                onChange={(event) =>
                  onRole(
                    member.principalId,
                    event.target.value as OrganizationRole,
                  )
                }
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="owner">Owner</option>
              </select>
            </label>
            <button
              type="button"
              className="compact"
              disabled={busy !== null}
              onClick={() => onRemove(member.principalId)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
