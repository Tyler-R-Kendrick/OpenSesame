import {
  ByoError,
  type ByoProviderInput,
  registerByoProvider,
} from "@opensesame/app-core/lib/byo.js";
import {
  beginSignIn,
  defaultUpstream,
} from "@opensesame/app-core/lib/federation.js";
import { isGuestSession } from "@opensesame/app-core/lib/guest-isolation.js";
import { remoteIdentityApi } from "@opensesame/app-core/lib/identity.js";
import {
  IDP_PRESETS,
  type IdpPreset,
  presetIssuer,
} from "@opensesame/app-core/lib/idp-presets.js";
import {
  type IdpProviderType,
  type IdpRecord,
  dismissIdpCeremony,
  listAdditionalIdpRegistrations,
  listIdpRegistrations,
  registerIdp,
  removeIdpRegistration,
} from "@opensesame/app-core/lib/idp-registry.js";
import {
  type FederatedProviderSummary,
  listFederatedProviders,
  providerUpstream,
} from "@opensesame/app-core/lib/providers.js";
import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router";
import { FailureNotice } from "../components/FailureNotice.js";
import { IconKey } from "../components/IconKey.js";
import {
  IconCheck,
  IconCopy,
  IconLogin,
  IconSite,
} from "../components/Icons.js";
import { StatusNote } from "../components/StatusNote.js";
import { useSectionView } from "../lib/section-views.js";
import { useIdentityConfigured } from "../lib/use-configured.js";
import { useOnline } from "../lib/use-online.js";
import { brandFor } from "../screens/unlock/ProviderBrand.js";
import { monogram } from "../lib/display-monogram.js";
import * as Directory from "./identity/DirectoryTabs.js";
import {
  OrganizationPanel,
  PeoplePanel,
  ServiceAccountsPanel,
} from "./identity/HostedIdentityPanels.js";
import { HostedConnectWorkspace } from "./identity/HostedRecordParts.js";
import type { IdentityTab } from "./identity/IdentityTabs.js";
import { LocalDirectoryWorkspace } from "./identity/LocalDirectoryWorkspace.js";
import { ProvidersWorkspace } from "./identity/ProvidersWorkspace.js";
import { useEnabledIdentityViews } from "./identity/identity-views.js";
import { providersListRoute } from "./identity/providers-list-route.js";
// Brand button treatments (.signin__social, .signin__provider--*) come from the sign-in hub's stylesheet; the ceremony reuses them verbatim.
import "../screens/unlock.css";
import "./identity.css";

import { identityErrorText } from "@opensesame/app-core/sections/identity-section-model.js";
import { useIdentitySession } from "../bindings/identity.js";
import { FormCommit } from "../components/FormCommit.js";
/**
 * Browser-local identity management, with optional hosted Identity
 * surfaces. Provider registration is an explicit ceremony, not an entry gate.
 */
function IdentityTabPanels({
  tab,
  online,
  configured,
  session,
  providers,
  flash,
  onSelectTab,
  onProvidersChanged,
  onOpenCeremony,
  ceremony,
}: {
  tab: IdentityTab;
  online: boolean;
  configured: boolean;
  session: ReturnType<typeof useIdentitySession>;
  providers: IdpRecord[];
  flash: Flash | null;
  onSelectTab: (tab: IdentityTab) => void;
  onProvidersChanged: (next: IdpRecord[]) => void;
  onOpenCeremony: () => void;
  ceremony?: ReactNode;
}) {
  // Guest sessions are local-vault IAM only — never hide Guest N behind a
  // hosted People panel the guest cannot see themselves in.
  const localOnly = isGuestSession() || !configured;
  return (
    <>
      <StatusNote title="Identity" message={flash} />
      {tab === "people" ? (
        localOnly ? (
          <LocalDirectoryWorkspace kind="person" />
        ) : (
          <PeoplePanel online={online} session={session} />
        )
      ) : null}
      {tab === "providers" ? (
        <ProvidersWorkspace
          online={online}
          providers={providers}
          onChanged={onProvidersChanged}
          onOpenCeremony={onOpenCeremony}
          editor={ceremony}
        />
      ) : null}
      {tab === "devices" ? (
        <Directory.DevicesTab online={online} session={session} />
      ) : null}
      {tab === "agents" ? (
        localOnly ? (
          <LocalDirectoryWorkspace kind="agent" />
        ) : session ? (
          <Directory.DirectoryAgents online={online} />
        ) : (
          <HostedConnectWorkspace
            online={online}
            title="Agents"
            view="agents"
          />
        )
      ) : null}
      {tab === "service-accounts" ? (
        localOnly ? (
          <LocalDirectoryWorkspace kind="application" />
        ) : (
          <ServiceAccountsPanel online={online} session={session} />
        )
      ) : null}
      {tab === "organization" ? (
        localOnly ? (
          <LocalDirectoryWorkspace kind="organization" />
        ) : (
          <OrganizationPanel
            online={online}
            session={session}
            onOpenPeople={() => onSelectTab("people")}
          />
        )
      ) : null}
    </>
  );
}

export function IdentitySection() {
  const online = useOnline();
  const configured = useIdentityConfigured();
  const session = useIdentitySession();
  const views = useEnabledIdentityViews();
  const [tab, setTab] = useSectionView(views, views[0] ?? "service-accounts");
  const [providers, setProviders] = useState<IdpRecord[]>(() =>
    listIdpRegistrations(),
  );
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const ceremonyOpen = tab === "providers" && params.get("action") === "new";
  const [flash, setFlash] = useState<Flash | null>(null);

  function openCeremony() {
    navigate(providersListRoute({ action: "new" }));
  }

  function closeCeremony() {
    if (listAdditionalIdpRegistrations().length === 0) dismissIdpCeremony();
    navigate(providersListRoute({}));
  }

  function registered(record: IdpRecord, message: string) {
    setProviders(listIdpRegistrations());
    navigate(providersListRoute({}, record.id));
    setFlash({ tone: "ok", text: message });
  }

  function providersChanged(next: IdpRecord[]) {
    setProviders(next);
  }

  return (
    <IdentityTabPanels
      tab={tab}
      online={online}
      configured={configured}
      session={session}
      providers={providers}
      flash={flash}
      onSelectTab={setTab}
      onProvidersChanged={providersChanged}
      onOpenCeremony={openCeremony}
      ceremony={
        ceremonyOpen ? (
          <IdpCeremony
            online={online}
            onRegistered={registered}
            onDismiss={closeCeremony}
          />
        ) : undefined
      }
    />
  );
}

/* --------------------------------------------------------------- ceremony */

/**
 * "Connect your identity provider" — Tailscale's mandatory signup ceremony
 * mapped onto our brokering. The primary path is the enterprise SSO presets
 * (WorkOS, Okta, Auth0, Better Auth), each a tailored form riding the shipped
 * BYO registration; then the generic custom-OIDC two-step; then the branded
 * first-class row (register + prove the binding in one gesture) as the
 * secondary "Sign-in providers" section.
 */
function IdpCeremony({
  online,
  onRegistered,
  onDismiss,
}: {
  online: boolean;
  onRegistered: (record: IdpRecord, message: string) => void;
  onDismiss: () => void;
}) {
  const [catalog, setCatalog] = useState<FederatedProviderSummary[] | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<IdpPreset | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await listFederatedProviders();
      if (!cancelled) setCatalog(found);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The catalog decides which branded buttons appear. When it is unreachable
  // the single default upstream is the fallback — first run must never
  // dead-end on a catalog fetch (the sign-in hub's rule, reused).
  const firstClass = useMemo<FederatedProviderSummary[]>(() => {
    if (catalog === null) return [];
    if (catalog.length > 0) return catalog;
    const fallback = defaultUpstream();
    return [
      {
        id: fallback.id,
        label: fallback.displayName,
        kind: "oidc",
        browserCapable: true,
      },
    ];
  }, [catalog]);

  async function choose(provider: FederatedProviderSummary) {
    setBusy(provider.id);
    setError(null);
    const upstream = providerUpstream(provider);
    const record: IdpRecord = {
      id: provider.id,
      issuer: upstream.issuer,
      label: provider.label,
      kind: "first-class",
      registeredAt: new Date().toISOString(),
    };
    const previous = listIdpRegistrations().find(
      (entry) => entry.id === record.id,
    );
    registerIdp(record);
    try {
      await beginSignIn(upstream, {
        providerHint: provider.id,
      });
      onRegistered(record, `Sign-in started with ${provider.label}.`);
    } catch (caught) {
      if (previous) registerIdp(previous);
      else removeIdpRegistration(record.id);
      setError(identityErrorText(caught));
      setBusy(null);
    }
  }

  return (
    <section className="detail identity-ceremony">
      <div className="detail__head">
        <div>
          <h1>Connect your identity provider</h1>
        </div>
      </div>

      <div className="detail__group">
        {preset ? (
          <IdpPresetForm
            preset={preset}
            online={online}
            disabled={busy !== null}
            onRegistered={onRegistered}
            onBack={() => setPreset(null)}
          />
        ) : (
          <div className="identity-presets">
            {IDP_PRESETS.map((candidate) => (
              <button
                key={candidate.type}
                type="button"
                className="identity-preset"
                disabled={busy !== null}
                onClick={() => setPreset(candidate)}
              >
                <span className="identity-preset__mark" aria-hidden="true">
                  {monogram(candidate.label)}
                </span>
                <span>{candidate.label}</span>
              </button>
            ))}
          </div>
        )}

        <div className="signin__divider" aria-hidden="true">
          or
        </div>

        <CustomOidcCard
          online={online}
          disabled={busy !== null}
          onRegistered={onRegistered}
        />

        <div className="signin__divider" aria-hidden="true">
          or
        </div>

        <h3 className="identity-ceremony__subhead">Sign-in providers</h3>
        {catalog === null ? (
          <output className="note">Asking for the provider catalog…</output>
        ) : (
          <div className="signin__bar identity-ceremony__bar">
            {firstClass.map((provider) => {
              const brand = brandFor(provider.id);
              return (
                <button
                  key={provider.id}
                  type="button"
                  className={`btn choice signin__social${
                    brand ? ` ${brand.className}` : ""
                  }`}
                  aria-label={`Continue with ${provider.label}`}
                  title={`Continue with ${provider.label}`}
                  disabled={busy !== null || !online}
                  onClick={() => void choose(provider)}
                >
                  {brand ? <brand.Icon size={20} /> : <IconLogin size={20} />}
                </button>
              );
            })}
          </div>
        )}

        <FailureNotice
          id="identity:idp-ceremony"
          title="Identity provider"
          message={error}
        />

        <FailureNotice
          id="identity:idp-offline"
          title="Offline"
          tone="warn"
          message={
            online
              ? null
              : "Offline — registration and sign-in both need the Identity service to answer."
          }
        />

        <button
          type="button"
          className="identity-ceremony__later"
          onClick={onDismiss}
        >
          Set up later
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------- BYO two-step submit */

type ByoRegistrationRequest = {
  issuer: string;
  providerType?: IdpProviderType;
  label?: string;
};

/**
 * The two-step BYO submit every issuer form rides (ADR 0055). Step 1 checks
 * the issuer (the server runs SSRF-fenced discovery and, where the provider
 * supports RFC 7591, registers a client itself). Step 2 — only when the
 * server answers `registration_unsupported` — takes a client ID and secret
 * created at the IdP, with the deployment's redirect URI to copy.
 */
function useByoRegistration(
  onRegistered: (record: IdpRecord, message: string) => void,
) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [needsClient, setNeedsClient] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(request: ByoRegistrationRequest): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const input: ByoProviderInput = { issuer: request.issuer };
      if (needsClient && clientId.trim()) input.clientId = clientId.trim();
      if (needsClient && clientSecret) input.clientSecret = clientSecret;
      const registration = await registerByoProvider(input);
      const label = request.label ?? registration.label;
      const record: IdpRecord = {
        id: registration.id,
        issuer: registration.issuer,
        label,
        kind: "byo",
        clientId: registration.clientId,
        clientAuth: registration.clientAuth,
        redirectUri: registration.redirectUri,
        registeredAt: new Date().toISOString(),
      };
      if (request.providerType) record.providerType = request.providerType;
      registerIdp(record);
      onRegistered(record, `${label} now vouches for sign-ins on this device.`);
    } catch (caught) {
      if (caught instanceof ByoError) {
        if (caught.code === "registration_unsupported") {
          // The provider has no RFC 7591 endpoint: open the manual client
          // fields rather than dead-ending on the message.
          setNeedsClient(true);
        }
        setError(caught.message);
      } else {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not check that provider.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return {
    clientId,
    setClientId,
    clientSecret,
    setClientSecret,
    needsClient,
    busy,
    error,
    setError,
    submit,
  };
}

/**
 * Step 2's manual client fields — revealed identically by the custom-OIDC
 * card and every preset form when the provider has no RFC 7591 endpoint.
 */
function ByoClientFields({
  idPrefix,
  disabled,
  clientId,
  clientSecret,
  onClientId,
  onClientSecret,
}: {
  idPrefix: string;
  disabled: boolean;
  clientId: string;
  clientSecret: string;
  onClientId: (value: string) => void;
  onClientSecret: (value: string) => void;
}) {
  const { copy, copied } = useCopy();

  // BYO callback lives on the remote Identity API (stableFederatedRedirectUri),
  // never the device-native host — which has no federated callback route.
  const remote = remoteIdentityApi().trim();
  const redirectUri = remote ? `${remote}/v1/federated/callback` : "";

  return (
    <>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-client-id`}>
          Client ID
        </label>
        <input
          id={`${idPrefix}-client-id`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={clientId}
          disabled={disabled}
          onChange={(event) => onClientId(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-client-secret`}>
          Client secret (optional)
        </label>
        <input
          id={`${idPrefix}-client-secret`}
          type="password"
          autoComplete="off"
          placeholder="optional — only sent to your provider"
          value={clientSecret}
          disabled={disabled}
          onChange={(event) => onClientSecret(event.target.value)}
        />
      </div>
      <div className="field">
        <span className="label">Redirect URI for your provider</span>
        {redirectUri ? (
          <>
            <div className="byo__uri">
              <code>{redirectUri}</code>
              <IconKey
                label="Copy redirect URI"
                onClick={() => copy(redirectUri, "redirect")}
              >
                {copied === "redirect" ? <IconCheck /> : <IconCopy />}
              </IconKey>
            </div>
          </>
        ) : (
          <p className="hint">No remote Identity URL.</p>
        )}
      </div>
    </>
  );
}

/**
 * A preset's tailored form — one visible at a time, back returns to the
 * preset tiles. Every preset assembles its issuer client-side, then rides
 * the same BYO two-step as the custom card.
 */
function IdpPresetForm({
  preset,
  online,
  disabled,
  onRegistered,
  onBack,
}: {
  preset: IdpPreset;
  online: boolean;
  disabled: boolean;
  onRegistered: (record: IdpRecord, message: string) => void;
  onBack: () => void;
}) {
  const [input, setInput] = useState("");
  const byo = useByoRegistration(onRegistered);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The issuer-lead field leads the form, so it leads the focus.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const fixedIssuer =
    preset.field === null ? presetIssuer(preset.type, "") : null;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const built = presetIssuer(preset.type, input);
    if (!built.ok) {
      byo.setError(built.error);
      return;
    }
    await byo.submit({
      issuer: built.issuer,
      providerType: preset.type,
      label: preset.label,
    });
  }

  return (
    <form
      className="identity-byoidc"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <div className="identity-preset__head">
        <span className="identity-preset__mark" aria-hidden="true">
          {monogram(preset.label)}
        </span>
        <h3>{preset.label}</h3>
      </div>

      {preset.field ? (
        <div className="field">
          <label className="label" htmlFor={`identity-preset-${preset.type}`}>
            <IconSite /> {preset.field.label}
          </label>
          <input
            id={`identity-preset-${preset.type}`}
            ref={inputRef}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={preset.field.placeholder}
            title={preset.field.hint}
            value={input}
            disabled={disabled || byo.busy}
            onChange={(event) => {
              setInput(event.target.value);
              byo.setError(null);
            }}
          />
        </div>
      ) : null}
      {fixedIssuer?.ok ? (
        <p className="hint">
          Issuer: <code>{fixedIssuer.issuer}</code>
        </p>
      ) : null}

      {byo.needsClient ? (
        <ByoClientFields
          idPrefix={`identity-preset-${preset.type}`}
          disabled={disabled || byo.busy}
          clientId={byo.clientId}
          clientSecret={byo.clientSecret}
          onClientId={byo.setClientId}
          onClientSecret={byo.setClientSecret}
        />
      ) : null}

      <FailureNotice
        id="identity:idp-preset"
        title="Identity provider"
        message={byo.error}
      />

      <div className="actions actions--end">
        <button
          type="button"
          className="btn"
          disabled={byo.busy}
          onClick={onBack}
        >
          Back
        </button>
        <FormCommit
          label={
            byo.busy
              ? "Checking issuer…"
              : byo.needsClient
                ? "Register with this client"
                : "Check issuer"
          }
          disabled={
            disabled ||
            byo.busy ||
            !online ||
            (preset.field !== null && input.trim().length === 0)
          }
          busy={byo.busy || undefined}
        />
      </div>
    </form>
  );
}

/**
 * Custom OIDC — Tailscale's "Sign up with OIDC" on ADR 0055's shipped path:
 * the generic issuer card, for any provider the presets do not name.
 */
function CustomOidcCard({
  online,
  disabled,
  onRegistered,
}: {
  online: boolean;
  disabled: boolean;
  onRegistered: (record: IdpRecord, message: string) => void;
}) {
  const [issuer, setIssuer] = useState("");
  const byo = useByoRegistration(onRegistered);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    await byo.submit({ issuer: issuer.trim() });
  }

  return (
    <form
      className="identity-byoidc"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <div className="field">
        <label className="label" htmlFor="identity-byoidc-issuer">
          <IconSite /> Custom OIDC issuer
        </label>
        <input
          id="identity-byoidc-issuer"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://auth.example.dev"
          value={issuer}
          disabled={disabled || byo.busy}
          onChange={(event) => {
            setIssuer(event.target.value);
            byo.setError(null);
          }}
        />
      </div>

      {byo.needsClient ? (
        <ByoClientFields
          idPrefix="identity-byoidc"
          disabled={disabled || byo.busy}
          clientId={byo.clientId}
          clientSecret={byo.clientSecret}
          onClientId={byo.setClientId}
          onClientSecret={byo.setClientSecret}
        />
      ) : null}

      <FailureNotice
        id="identity:idp-custom"
        title="Custom provider"
        message={byo.error}
      />

      <div className="actions actions--end">
        <FormCommit
          label={
            byo.busy
              ? "Checking issuer…"
              : byo.needsClient
                ? "Register with this client"
                : "Check issuer"
          }
          disabled={
            disabled || byo.busy || !online || issuer.trim().length === 0
          }
          busy={byo.busy || undefined}
        />
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ people */

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
