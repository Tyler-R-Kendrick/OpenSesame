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
  IconCopy,
  IconLogin,
  IconPasskey,
  IconRefresh,
  IconShield,
  IconSite,
  IconUser,
} from "../components/Icons.js";
import {
  type Delegation,
  type DelegationOffer,
  claimDelegation,
  listDelegations,
  revokeDelegation,
} from "../lib/access.js";
import {
  ByoError,
  type ByoProviderInput,
  registerByoProvider,
} from "../lib/byo.js";
import { presentOffer } from "../lib/claim.js";
import {
  DirectoryError,
  type DirectoryPrincipal,
  type LinkedIdentity,
  type OAuthClient,
  type OrgMember,
  addOrgMember,
  approveDevice,
  createOAuthClient,
  createOrganization,
  getMe,
  listLinkedIdentities,
  listOAuthClients,
  listOrgMembers,
  removeOrgMember,
  revokeOAuthClient,
  rotateOAuthClient,
  unlinkIdentity,
} from "../lib/directory.js";
import { beginSignIn, defaultUpstream } from "../lib/federation.js";
import {
  type IdentitySession,
  identityBase,
  useConnect,
  useIdentitySession,
} from "../lib/identity.js";
import {
  IDP_PRESETS,
  type IdpPreset,
  presetFor,
  presetIssuer,
} from "../lib/idp-presets.js";
import {
  type IdpProviderType,
  type IdpRecord,
  ceremonyDismissed,
  dismissIdpCeremony,
  listIdpRegistrations,
  registerIdp,
  removeIdpRegistration,
} from "../lib/idp-registry.js";
import {
  GUEST_PROFILE_ID,
  ORG_SLUG_RE,
  type OrgMembership,
  activeOrgProfileId,
  listOrgMemberships,
} from "../lib/orgs.js";
import {
  type FederatedProviderSummary,
  brokeredByoUpstream,
  brokeredUpstream,
  listFederatedProviders,
} from "../lib/providers.js";
import { useOnline } from "../lib/use-online.js";
import { brandFor } from "../screens/unlock/ProviderBrand.js";
import { useGuideTarget } from "../tutorial/registry/react.jsx";
import { monogram } from "./connections/connector-marks.js";
import type { Flash } from "./connections/shared.js";
// The brand button treatments (.signin__social, .signin__provider--*) live in
// the sign-in hub's stylesheet; the ceremony reuses them verbatim.
import "../screens/unlock.css";
import "./identity.css";

type IdentityTab =
  | "people"
  | "providers"
  | "devices"
  | "service-accounts"
  | "organization";

const TABS: Array<{ id: IdentityTab; label: string; guideId: string }> = [
  { id: "people", label: "People", guideId: "identity.people" },
  { id: "providers", label: "Providers", guideId: "identity.providers" },
  { id: "devices", label: "Devices", guideId: "identity.devices" },
  {
    id: "service-accounts",
    label: "Service accounts",
    guideId: "identity.service-accounts",
  },
  {
    id: "organization",
    label: "Organization",
    guideId: "identity.organization",
  },
];

/** One tab, named so a guide can point at it without knowing the markup. */
function IdentityTabButton({
  guideId,
  label,
  active,
  onSelect,
}: {
  guideId: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  const ref = useGuideTarget<HTMLButtonElement>(guideId);
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={active}
      className={`identity-tab${active ? " is-active" : ""}`}
      onClick={onSelect}
    >
      {label}
    </button>
  );
}

/**
 * Identity — the person plane (ADR 0060, ADR 0061). Tailscale's identity IA
 * as the parity target: a first-navigation ceremony that binds an IdP, then
 * five tabs, one visible at a time — people (with the requester side of JIT),
 * providers, devices (approve-a-device), service accounts, organization.
 * Every tab binds APIs the Identity and Host services already serve; loads
 * are best-effort and independent, so a down plane degrades tabs individually.
 */
export function IdentitySection() {
  const online = useOnline();
  const session = useIdentitySession();
  const [tab, setTab] = useState<IdentityTab>("people");
  const [providers, setProviders] = useState<IdpRecord[]>(() =>
    listIdpRegistrations(),
  );
  const [dismissed, setDismissed] = useState(() => ceremonyDismissed());
  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  // The gate: no binding recorded and no explicit deferral. Re-opening the
  // ceremony from a tab is always possible and lifts nothing permanently.
  const gated = providers.length === 0 && !dismissed;
  const showCeremony = ceremonyOpen || gated;

  function openCeremony() {
    setCeremonyOpen(true);
  }

  function closeCeremony() {
    if (providers.length === 0) {
      // "Set up later" is the guest-primacy escape, and it is sticky.
      dismissIdpCeremony();
      setDismissed(true);
    }
    setCeremonyOpen(false);
  }

  function registered(record: IdpRecord, message: string) {
    setProviders(listIdpRegistrations());
    // Registering lifts the gate permanently — the store says so, and the
    // local gate state must agree before the mirror can empty again.
    setDismissed(true);
    setCeremonyOpen(false);
    setTab("providers");
    setFlash({ tone: "ok", text: message });
  }

  function providersChanged(next: IdpRecord[]) {
    setProviders(next);
    setDismissed(ceremonyDismissed());
  }

  return (
    <div className="section__inner">
      <header className="section__head">
        <h1>Identity</h1>
      </header>

      {showCeremony ? (
        <IdpCeremony
          online={online}
          gated={gated}
          onRegistered={registered}
          onDismiss={closeCeremony}
        />
      ) : (
        <>
          <div
            className="identity-tabs"
            role="tablist"
            aria-label="Identity views"
          >
            {TABS.map(({ id, label, guideId }) => (
              <IdentityTabButton
                key={id}
                guideId={guideId}
                label={label}
                active={tab === id}
                onSelect={() => setTab(id)}
              />
            ))}
          </div>

          {flash ? (
            <output className={`note note--${flash.tone}`}>
              {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
              <p>{flash.text}</p>
            </output>
          ) : null}

          {tab === "people" ? (
            <PeoplePanel
              online={online}
              session={session}
              onOpenCeremony={openCeremony}
            />
          ) : null}
          {tab === "providers" ? (
            <ProvidersPanel
              online={online}
              providers={providers}
              onChanged={providersChanged}
              onOpenCeremony={openCeremony}
            />
          ) : null}
          {tab === "devices" ? (
            <DevicesPanel online={online} session={session} />
          ) : null}
          {tab === "service-accounts" ? (
            <ServiceAccountsPanel online={online} session={session} />
          ) : null}
          {tab === "organization" ? (
            <OrganizationPanel
              online={online}
              session={session}
              onOpenPeople={() => setTab("people")}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function identityErrorText<Thrown>(error: Thrown): string {
  if (error instanceof DirectoryError) return error.message;
  if (error instanceof ByoError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
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
  gated,
  onRegistered,
  onDismiss,
}: {
  online: boolean;
  gated: boolean;
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
        browserCapable: false,
      },
    ];
  }, [catalog]);

  const brokerNotes = useMemo(
    () =>
      firstClass
        .map((provider) => brandFor(provider.id)?.note)
        .filter((note): note is string => note !== undefined),
    [firstClass],
  );

  async function choose(provider: FederatedProviderSummary) {
    setBusy(provider.id);
    setError(null);
    const record: IdpRecord = {
      id: provider.id,
      // A first-class leg is brokered: the issuer this device speaks is the
      // Identity API, with the provider carried as the hint.
      issuer: identityBase(),
      label: provider.label,
      kind: "first-class",
      registeredAt: new Date().toISOString(),
    };
    registerIdp(record);
    try {
      await beginSignIn(brokeredUpstream(provider), {
        providerHint: provider.id,
      });
      onRegistered(
        record,
        `${provider.label} now vouches for sign-ins on this device.`,
      );
    } catch (caught) {
      // The leg could not start, so the binding is unproven — drop the record
      // again and say why, instead of lifting the gate on a broken binding.
      removeIdpRegistration(record.id);
      setError(identityErrorText(caught));
      setBusy(null);
    }
  }

  return (
    <section className="panel identity-ceremony">
      <div className="panel__head">
        <div>
          <h2>Connect your identity provider</h2>
        </div>
      </div>

      <div className="panel__body">
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
                  className={`btn signin__social${
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

        {brokerNotes.map((note) => (
          <p className="hint signin__provider-note" key={note}>
            {note}
          </p>
        ))}

        {error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : null}

        {!online ? (
          <output className="note note--warn">
            <IconAlert /> Offline — registration and sign-in both need the
            Identity service to answer.
          </output>
        ) : null}

        <button
          type="button"
          className="identity-ceremony__later"
          onClick={onDismiss}
        >
          Set up later
        </button>
        {gated ? (
          <p className="hint identity-ceremony__later-note">
            You can register an identity provider at any time from the Providers
            tab.
          </p>
        ) : null}
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

  // The deployment-wide callback every BYO registration is bound to
  // server-side (stableFederatedRedirectUri); the IdP must allow it exactly.
  const redirectUri = `${identityBase()}/v1/federated/callback`;

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
        <div className="byo__uri">
          <code>{redirectUri}</code>
          <button
            type="button"
            className="icon-btn"
            aria-label="Copy redirect URI"
            title="Copy redirect URI"
            onClick={() => copy(redirectUri, "redirect")}
          >
            {copied === "redirect" ? <IconCheck /> : <IconCopy />}
          </button>
        </div>
        <p className="hint">
          {copied === "redirect"
            ? "Copied. Add it to your provider's allowed redirect URIs."
            : "Register this exact redirect URI at your provider."}
        </p>
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
            value={input}
            disabled={disabled || byo.busy}
            onChange={(event) => {
              setInput(event.target.value);
              byo.setError(null);
            }}
          />
          <p className="hint">{preset.field.hint}</p>
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

      {byo.error ? (
        <p className="note note--err" role="alert">
          <IconAlert /> {byo.error}
        </p>
      ) : null}

      <div className="actions actions--end">
        <button
          type="button"
          className="btn"
          disabled={byo.busy}
          onClick={onBack}
        >
          Back
        </button>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={
            disabled ||
            byo.busy ||
            !online ||
            (preset.field !== null && input.trim().length === 0)
          }
          aria-busy={byo.busy || undefined}
        >
          {byo.busy
            ? "Checking issuer…"
            : byo.needsClient
              ? "Register with this client"
              : "Check issuer"}
        </button>
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

      {byo.error ? (
        <p className="note note--err" role="alert">
          <IconAlert /> {byo.error}
        </p>
      ) : null}

      <div className="actions actions--end">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={
            disabled || byo.busy || !online || issuer.trim().length === 0
          }
          aria-busy={byo.busy || undefined}
        >
          {byo.busy
            ? "Checking issuer…"
            : byo.needsClient
              ? "Register with this client"
              : "Check issuer"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ people */

function PeoplePanel({
  online,
  session,
  onOpenCeremony,
}: {
  online: boolean;
  session: IdentitySession | null;
  onOpenCeremony: () => void;
}) {
  const [claimOpen, setClaimOpen] = useState(false);
  const [accessNonce, setAccessNonce] = useState(0);

  if (!session) {
    return (
      <ConnectIdentityNote
        online={online}
        what="Who you are here, which providers vouch for you, and who shares your organizations"
      />
    );
  }

  // One ceremony at a time: claiming access takes over the tab, with a
  // back-link out, never fields appended to the list.
  if (claimOpen) {
    return (
      <ClaimAccessCeremony
        online={online}
        onDone={(claimed) => {
          setClaimOpen(false);
          if (claimed) setAccessNonce((nonce) => nonce + 1);
        }}
      />
    );
  }

  return (
    <>
      <MeCard online={online} onOpenCeremony={onOpenCeremony} />
      <LinkedIdentitiesCard online={online} />
      {/* Remount on a fresh claim so the new grant is simply there. */}
      <MyAccessCard
        key={accessNonce}
        online={online}
        session={session}
        onOpenClaim={() => setClaimOpen(true)}
      />
      <OrgMembersCard online={online} />
    </>
  );
}

/* --------------------------------------------------------------- my access */

/**
 * The requester side of JIT (ADR 0061): grants this principal holds, with
 * their expiry, and the claim ceremony that adds one. Bound to the same
 * delegation seams the Access screen uses.
 */
function MyAccessCard({
  online,
  session,
  onOpenClaim,
}: {
  online: boolean;
  session: IdentitySession;
  onOpenClaim: () => void;
}) {
  const claimRef = useGuideTarget<HTMLButtonElement>("identity.claim-access");
  const [rows, setRows] = useState<Delegation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const run = useRef(0);
  const now = useNow(30_000);

  const load = useCallback(async () => {
    const id = ++run.current;
    try {
      const all = await listDelegations();
      if (run.current !== id) return;
      // The list also carries grants I minted for others — My access is only
      // the rows I claimed and have not dropped.
      setRows(
        all.filter(
          (delegation) =>
            delegation.claimantSubject === session.principalId &&
            delegation.revokedAt === null,
        ),
      );
      setError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setRows(null);
      setError(identityErrorText(caught));
    }
  }, [session.principalId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function drop(delegation: Delegation) {
    setBusyId(delegation.id);
    setFlash(null);
    try {
      await revokeDelegation(delegation.id);
      setFlash({ tone: "ok", text: "Access dropped." });
      setConfirmId(null);
      void load();
    } catch (caught) {
      setFlash({ tone: "err", text: identityErrorText(caught) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>My access</h2>
        </div>
        <div className="actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => void load()}
            disabled={!online}
            title="Reload my access"
            aria-label="Reload my access"
          >
            <IconRefresh />
          </button>
          <button
            ref={claimRef}
            type="button"
            className="btn btn--sm btn--primary"
            onClick={onOpenClaim}
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

        {rows === null && !error ? (
          <output className="note">Asking the Host…</output>
        ) : null}

        {rows && rows.length > 0 ? (
          <ul className="identity-rows">
            {rows.map((delegation) => (
              <li className="identity-row" key={delegation.id}>
                <div className="identity-row__main">
                  <span className="identity-row__mark">
                    <IconShield size={18} />
                  </span>
                  <div className="identity-row__id">
                    <h3>
                      {delegation.resources.length > 0
                        ? delegation.resources.join(", ")
                        : delegation.connectionId}
                    </h3>
                    <code className="identity-ref">
                      {delegation.connectionId}
                    </code>
                  </div>
                  {delegation.actions.map((action) => (
                    <span className="chip" key={action}>
                      {action}
                    </span>
                  ))}
                  <span className="chip">{delegation.executionMode}</span>
                  <span className="identity-row__when">
                    expires {countdown(delegation.expiresAt, now)}
                  </span>
                  <div className="actions">
                    {confirmId === delegation.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn--sm btn--danger"
                          disabled={busyId !== null || !online}
                          onClick={() => void drop(delegation)}
                        >
                          {busyId === delegation.id ? "Dropping…" : "Drop it"}
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => setConfirmId(null)}
                        >
                          Keep it
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        disabled={busyId !== null || !online}
                        onClick={() => setConfirmId(delegation.id)}
                      >
                        Drop
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {rows && rows.length === 0 ? (
          <p className="hint">
            No access held — claim a code an owner hands you.
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
  );
}

type ClaimStep = "enter" | "review";

/**
 * Claim access — paste the claim token and user code an owner handed over,
 * review the offered scope, accept. Present spends the offer's one
 * presentation (ADR 0044), so the review is the decision point: accept posts
 * every offered item id, back leaves the grant unclaimed.
 */
function ClaimAccessCeremony({
  online,
  onDone,
}: {
  online: boolean;
  onDone: (claimed: boolean) => void;
}) {
  const [step, setStep] = useState<ClaimStep>("enter");
  const [claimToken, setClaimToken] = useState("");
  const [userCode, setUserCode] = useState("");
  const [offer, setOffer] = useState<DelegationOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<HTMLInputElement | null>(null);

  // The token leads the ceremony, so it leads the form.
  useEffect(() => {
    tokenRef.current?.focus();
  }, []);

  async function present(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const found = await presentOffer(claimToken.trim());
      setOffer(found);
      setStep("review");
    } catch (caught) {
      setError(identityErrorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    if (!offer) return;
    setError(null);
    setBusy(true);
    try {
      await claimDelegation({
        claimToken: claimToken.trim(),
        userCode: userCode.trim(),
        acceptedItemIds: offer.items.map((item) => item.id),
      });
      onDone(true);
    } catch (caught) {
      setError(identityErrorText(caught));
      setBusy(false);
    }
  }

  return (
    <section className="panel identity-ceremony">
      <div className="panel__head">
        <div>
          <h2>Claim access</h2>
        </div>
      </div>

      <div className="panel__body">
        {step === "enter" ? (
          <form
            className="identity-claim"
            onSubmit={(event) => void present(event)}
            noValidate
          >
            <div className="field">
              <label className="label" htmlFor="identity-claim-token">
                Claim token
              </label>
              <input
                id="identity-claim-token"
                ref={tokenRef}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={claimToken}
                disabled={busy}
                onChange={(event) => {
                  setClaimToken(event.target.value);
                  setError(null);
                }}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="identity-claim-code">
                User code
              </label>
              <input
                id="identity-claim-code"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="WORD-WORD"
                value={userCode}
                disabled={busy}
                onChange={(event) => {
                  setUserCode(event.target.value);
                  setError(null);
                }}
              />
            </div>

            {error ? (
              <p className="note note--err" role="alert">
                <IconAlert /> {error}
              </p>
            ) : null}

            <div className="actions actions--end">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => onDone(false)}
              >
                Back
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={
                  busy || !online || !claimToken.trim() || !userCode.trim()
                }
                aria-busy={busy || undefined}
              >
                {busy ? "Asking…" : "Review offer"}
              </button>
            </div>
          </form>
        ) : null}

        {step === "review" && offer ? (
          <>
            <ul className="identity-rows">
              {offer.items.map((item) => (
                <li className="identity-row" key={item.id}>
                  <div className="identity-row__main">
                    <div className="identity-row__id">
                      <h3>{item.displayName}</h3>
                      <code className="identity-ref">{item.connectionId}</code>
                    </div>
                    {item.actions.map((action) => (
                      <span className="chip" key={action}>
                        {action}
                      </span>
                    ))}
                    <span className="chip">{item.executionMode}</span>
                  </div>
                  {item.resources.length > 0 ? (
                    <p className="hint">{item.resources.join(", ")}</p>
                  ) : null}
                </li>
              ))}
            </ul>

            {error ? (
              <p className="note note--err" role="alert">
                <IconAlert /> {error}
              </p>
            ) : null}

            <div className="actions actions--end">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => onDone(false)}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy || !online}
                aria-busy={busy || undefined}
                onClick={() => void accept()}
              >
                {busy ? "Claiming…" : "Accept"}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

const PRINCIPAL_STATE_CHIP = new Map([
  ["provisional", { label: "Guest", tone: "chip--warn" }],
  ["active", { label: "active", tone: "chip--ok" }],
  ["suspended", { label: "suspended", tone: "chip--err" }],
  ["closed", { label: "closed", tone: "" }],
]);

function stateChip(state: string): { label: string; tone: string } {
  return PRINCIPAL_STATE_CHIP.get(state) ?? { label: state, tone: "" };
}

/** Principal ids are opaque and long; show enough to recognise, copy the rest. */
function truncateId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 14)}…${id.slice(-4)}` : id;
}

function MeCard({
  online,
  onOpenCeremony,
}: {
  online: boolean;
  onOpenCeremony: () => void;
}) {
  const [me, setMe] = useState<DirectoryPrincipal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const { copy, copied } = useCopy();

  const load = useCallback(async () => {
    const id = ++run.current;
    try {
      const principal = await getMe();
      if (run.current !== id) return;
      setMe(principal);
      setError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setMe(null);
      setError(identityErrorText(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const guest = me !== null && me.state === "provisional";

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>You</h2>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void load()}
          disabled={!online}
          title="Reload"
          aria-label="Reload"
        >
          <IconRefresh />
        </button>
      </div>

      <div className="panel__body">
        {error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : null}

        {me === null && !error ? (
          <output className="note">Asking Identity…</output>
        ) : null}

        {me ? (
          <>
            <dl className="kv">
              <div>
                <dt>Principal</dt>
                <dd>
                  <code title={me.id}>{truncateId(me.id)}</code>{" "}
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => copy(me.id, "principal")}
                    title="Copy principal id"
                    aria-label="Copy principal id"
                  >
                    {copied === "principal" ? <IconCheck /> : <IconCopy />}
                  </button>
                </dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>
                  <span className={`chip ${stateChip(me.state).tone}`}>
                    {stateChip(me.state).label}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Assurance</dt>
                <dd>
                  <span className="chip">{me.assurance}</span>
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatTime(me.createdAt)}</dd>
              </div>
            </dl>

            {guest ? (
              <div className="identity-guest">
                <p className="hint">
                  No identity provider vouches for this identity yet — a guest
                  principal is provisional and expires.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    onClick={onOpenCeremony}
                  >
                    Register an identity provider
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

/** One principal, many IdPs — the model Tailscale does not have, made visible. */
function LinkedIdentitiesCard({ online }: { online: boolean }) {
  const [identities, setIdentities] = useState<LinkedIdentity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    try {
      const rows = await listLinkedIdentities();
      if (run.current !== id) return;
      setIdentities(rows);
      setError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setIdentities(null);
      setError(identityErrorText(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function unlink(identity: LinkedIdentity) {
    setBusyId(identity.id);
    setFlash(null);
    try {
      await unlinkIdentity(identity.id);
      setFlash({
        tone: "ok",
        text: `${identity.displayHint ?? identity.issuer} was unlinked.`,
      });
      setConfirmId(null);
      void load();
    } catch (caught) {
      setFlash({ tone: "err", text: identityErrorText(caught) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Linked identities</h2>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void load()}
          disabled={!online}
          title="Reload identities"
          aria-label="Reload identities"
        >
          <IconRefresh />
        </button>
      </div>

      <div className="panel__body">
        {error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : null}

        {identities === null && !error ? (
          <output className="note">Asking Identity…</output>
        ) : null}

        {identities && identities.length > 0 ? (
          <ul className="identity-rows">
            {identities.map((identity) => {
              const KindIcon = kindIcon(identity.kind);
              return (
                <li className="identity-row" key={identity.id}>
                  <div className="identity-row__main">
                    <span className="identity-row__mark">
                      <KindIcon size={18} />
                    </span>
                    <div className="identity-row__id">
                      <h3>{identity.displayHint ?? identity.issuer}</h3>
                      <code className="identity-ref">{identity.issuer}</code>
                    </div>
                    <span className="chip">{identity.kind}</span>
                    <span className="chip">{identity.assurance}</span>
                    {identity.linkedAt ? (
                      <span className="identity-row__when">
                        linked {formatTime(identity.linkedAt)}
                      </span>
                    ) : null}
                    <div className="actions">
                      {confirmId === identity.id ? (
                        <>
                          <button
                            type="button"
                            className="btn btn--sm btn--danger"
                            disabled={busyId !== null || !online}
                            onClick={() => void unlink(identity)}
                          >
                            {busyId === identity.id
                              ? "Unlinking…"
                              : "Unlink it"}
                          </button>
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => setConfirmId(null)}
                          >
                            Keep it
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--sm btn--danger"
                          disabled={busyId !== null || !online}
                          onClick={() => setConfirmId(identity.id)}
                        >
                          Unlink
                        </button>
                      )}
                    </div>
                  </div>
                  {confirmId === identity.id ? (
                    <p className="hint">
                      The account at the provider itself is untouched.
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {identities && identities.length === 0 ? (
          <div className="empty">
            <h3>No linked identities</h3>
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

function kindIcon(kind: string): typeof IconUser {
  if (kind === "passkey") return IconPasskey;
  if (kind === "oidc") return IconLogin;
  return IconUser;
}

/**
 * Members of the active org profile. The API knows principal ids and roles —
 * nothing else: there is no invite-by-email and no last-seen to show.
 */
function OrgMembersCard({ online }: { online: boolean }) {
  const profileId = activeOrgProfileId();
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [principalId, setPrincipalId] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    if (profileId === GUEST_PROFILE_ID) return;
    const id = ++run.current;
    try {
      const [rows, memberships] = await Promise.all([
        listOrgMembers(profileId),
        listOrgMemberships(),
      ]);
      if (run.current !== id) return;
      setMembers(rows);
      setMyRole(memberships.find((org) => org.id === profileId)?.role ?? null);
      setError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setMembers(null);
      setError(identityErrorText(caught));
    }
  }, [profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(event: FormEvent) {
    event.preventDefault();
    const id = principalId.trim();
    if (!id) return;
    setBusy(true);
    setFlash(null);
    try {
      await addOrgMember(profileId, id, role);
      setFlash({ tone: "ok", text: `${id} was added as ${role}.` });
      setPrincipalId("");
      void load();
    } catch (caught) {
      setFlash({ tone: "err", text: identityErrorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(member: OrgMember) {
    setBusy(true);
    setFlash(null);
    try {
      await removeOrgMember(member.organizationId, member.principalId);
      setFlash({
        tone: "ok",
        text: `${member.principalId} was removed from the organization.`,
      });
      setConfirmId(null);
      void load();
    } catch (caught) {
      setFlash({ tone: "err", text: identityErrorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  if (profileId === GUEST_PROFILE_ID) return null;

  const owner = myRole === "owner";

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Organization members</h2>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void load()}
          disabled={!online}
          title="Reload members"
          aria-label="Reload members"
        >
          <IconRefresh />
        </button>
      </div>

      <div className="panel__body">
        {error ? (
          <p className="note note--err" role="alert">
            <IconAlert /> {error}
          </p>
        ) : null}

        {members === null && !error ? (
          <output className="note">Asking Identity…</output>
        ) : null}

        {members && members.length > 0 ? (
          <ul className="identity-rows">
            {members.map((member) => (
              <li className="identity-row" key={member.principalId}>
                <div className="identity-row__main">
                  <span className="identity-row__mark">
                    <IconUser size={18} />
                  </span>
                  <div className="identity-row__id">
                    <h3>
                      <code className="identity-ref">
                        {truncateId(member.principalId)}
                      </code>
                    </h3>
                  </div>
                  <span className="chip">{member.role}</span>
                  {owner ? (
                    <div className="actions">
                      {confirmId === member.principalId ? (
                        <>
                          <button
                            type="button"
                            className="btn btn--sm btn--danger"
                            disabled={busy || !online}
                            onClick={() => void remove(member)}
                          >
                            Remove them
                          </button>
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => setConfirmId(null)}
                          >
                            Keep them
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--sm btn--danger"
                          disabled={busy || !online}
                          onClick={() => setConfirmId(member.principalId)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {members && members.length === 0 ? (
          <p className="hint">Only you are a member of this organization.</p>
        ) : null}

        {owner ? (
          <form className="identity-addmember" onSubmit={(e) => void add(e)}>
            <div className="field">
              <label className="label" htmlFor="identity-member-principal">
                Add a member by principal id
              </label>
              <input
                id="identity-member-principal"
                value={principalId}
                onChange={(event) => setPrincipalId(event.target.value)}
                placeholder="prn_…"
                spellCheck={false}
                autoComplete="off"
                disabled={busy}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="identity-member-role">
                Role
              </label>
              <select
                id="identity-member-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                disabled={busy}
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
                <option value="owner">owner</option>
              </select>
            </div>
            <div className="actions actions--end">
              <button
                type="submit"
                className="btn btn--sm btn--primary"
                disabled={busy || !online || !principalId.trim()}
              >
                {busy ? "Adding…" : "Add member"}
              </button>
            </div>
          </form>
        ) : members !== null ? (
          <p className="hint">Only the owner can add or remove members.</p>
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

/* ----------------------------------------------------------------- devices */

/**
 * Devices — the browser-reachable device act (ADR 0061): approving the user
 * code a device or CLI shows. Enumeration stays with the operator; there is
 * no browser-reachable list route, so the tab says so instead of faking one.
 */
function DevicesPanel({
  online,
  session,
}: {
  online: boolean;
  session: IdentitySession | null;
}) {
  if (!session) {
    return (
      <ConnectIdentityNote
        online={online}
        what="Approving the devices that sign in"
      />
    );
  }
  return <ApproveDeviceCard online={online} />;
}

function ApproveDeviceCard({ online }: { online: boolean }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Flash | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);

  // The user code is the whole ceremony, so it leads the form.
  useEffect(() => {
    codeRef.current?.focus();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const userCode = code.trim();
    if (!userCode) return;
    setBusy(true);
    setResult(null);
    try {
      await approveDevice(userCode);
      setResult({ tone: "ok", text: "Device approved." });
      setCode("");
      codeRef.current?.focus();
    } catch (caught) {
      setResult({ tone: "err", text: identityErrorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Approve a device</h2>
        </div>
      </div>

      <div className="panel__body">
        <form
          className="identity-claim"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <div className="field">
            <label className="label" htmlFor="identity-device-code">
              User code
            </label>
            <input
              id="identity-device-code"
              ref={codeRef}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="WORD-WORD"
              value={code}
              disabled={busy}
              onChange={(event) => {
                setCode(event.target.value);
                setResult(null);
              }}
            />
          </div>

          {result ? (
            <p
              className={`note note--${result.tone}`}
              role={result.tone === "err" ? "alert" : undefined}
            >
              {result.tone === "ok" ? <IconCheck /> : <IconAlert />}
              {result.text}
            </p>
          ) : null}

          <div className="actions actions--end">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !online || !code.trim()}
              aria-busy={busy || undefined}
            >
              {busy ? "Approving…" : "Approve device"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- providers */

/**
 * Who vouches for the people here. Rows come from the local registry — the
 * only list a browser can hold, since the server-side registration list is
 * operator-token-only. First-class rows are intersected with the live catalog
 * when it answers; BYO rows are the registry mirror itself.
 */
function ProvidersPanel({
  online,
  providers,
  onChanged,
  onOpenCeremony,
}: {
  online: boolean;
  providers: IdpRecord[];
  onChanged: (providers: IdpRecord[]) => void;
  onOpenCeremony: () => void;
}) {
  const [catalog, setCatalog] = useState<FederatedProviderSummary[] | null>(
    null,
  );
  const registerRef = useGuideTarget<HTMLButtonElement>(
    "identity.register-idp",
  );

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

  const rows = useMemo(() => {
    if (!catalog || catalog.length === 0) return providers;
    const listed = new Set(catalog.map((provider) => provider.id));
    return providers.filter(
      (record) => record.kind === "byo" || listed.has(record.id),
    );
  }, [catalog, providers]);

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Who vouches for them</h2>
        </div>
        <div className="actions">
          <button
            ref={registerRef}
            type="button"
            className="btn btn--sm btn--primary"
            onClick={onOpenCeremony}
          >
            Register an IdP
          </button>
        </div>
      </div>

      <div className="panel__body">
        {providers.length === 0 ? (
          <div className="empty">
            <h3>No identity provider registered.</h3>
            <button
              type="button"
              className="btn btn--primary"
              onClick={onOpenCeremony}
            >
              Register an IdP
            </button>
          </div>
        ) : (
          <ul className="identity-rows">
            {rows.map((record) => (
              <ProviderRow
                key={record.id}
                record={record}
                online={online}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ProviderRow({
  record,
  online,
  onChanged,
}: {
  record: IdpRecord;
  online: boolean;
  onChanged: (providers: IdpRecord[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const brand = record.kind === "first-class" ? brandFor(record.id) : null;
  const preset = record.providerType ? presetFor(record.providerType) : null;

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      if (record.kind === "byo") {
        await beginSignIn(
          brokeredByoUpstream({
            issuer: record.issuer,
            label: record.label,
          }),
        );
      } else {
        const summary: FederatedProviderSummary = {
          id: record.id,
          label: record.label,
          kind: "oidc",
          browserCapable: false,
        };
        await beginSignIn(brokeredUpstream(summary), {
          providerHint: record.id,
        });
      }
    } catch (caught) {
      setError(identityErrorText(caught));
      setBusy(false);
    }
  }

  function remove() {
    // Local mirror only: the server-side registration is disabled by the
    // operator, never deleted from a browser.
    onChanged(removeIdpRegistration(record.id));
  }

  return (
    <li className="identity-row">
      <div className="identity-row__main">
        <span className="identity-row__mark">
          {brand ? (
            <brand.Icon size={18} />
          ) : preset ? (
            <span className="identity-row__monogram" aria-hidden="true">
              {monogram(preset.label)}
            </span>
          ) : (
            <IconSite size={18} />
          )}
        </span>
        <div className="identity-row__id">
          <h3>{record.label}</h3>
          <code className="identity-ref">{record.issuer}</code>
        </div>
        <span className="chip">
          {record.kind === "first-class"
            ? "First-class"
            : (preset?.label ?? "Custom OIDC")}
        </span>
        {record.kind === "byo" ? (
          <span className="identity-row__when">
            registered {formatTime(record.registeredAt)}
          </span>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy || !online}
            onClick={() => void signIn()}
          >
            {busy ? "Starting…" : "Sign in"}
          </button>
          {confirming ? (
            <>
              <button
                type="button"
                className="btn btn--sm btn--danger"
                onClick={remove}
              >
                Remove it
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setConfirming(false)}
              >
                Keep it
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--sm btn--danger"
              onClick={() => setConfirming(true)}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {confirming ? (
        <p className="hint">
          The server-side registration is disabled by the operator, not deleted.
        </p>
      ) : null}
      {error ? (
        <p className="note note--err" role="alert">
          <IconAlert /> {error}
        </p>
      ) : null}
    </li>
  );
}

/* -------------------------------------------------------- service accounts */

/**
 * Identities that aren't people: the owner-fenced OAuth clients. Host-plane
 * service accounts (agents) deliberately live on the Access screen — this tab
 * cross-links rather than duplicating them.
 */
function ServiceAccountsPanel({
  online,
  session,
}: {
  online: boolean;
  session: IdentitySession | null;
}) {
  const [clients, setClients] = useState<OAuthClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [rotated, setRotated] = useState<OAuthClient | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const run = useRef(0);
  const { copy, copied } = useCopy();

  const load = useCallback(async () => {
    const id = ++run.current;
    try {
      const rows = await listOAuthClients();
      if (run.current !== id) return;
      setClients(rows);
      setError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setClients(null);
      setError(identityErrorText(caught));
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void load();
  }, [load, session]);

  async function rotate(client: OAuthClient) {
    setBusyId(client.id);
    setFlash(null);
    setRotated(null);
    try {
      const next = await rotateOAuthClient(client.id);
      // The old client id is revoked server-side; the new one is the whole
      // response, so it is shown once here and then lives only in the list.
      setRotated(next);
      void load();
    } catch (caught) {
      setFlash({ tone: "err", text: identityErrorText(caught) });
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(client: OAuthClient) {
    setBusyId(client.id);
    setFlash(null);
    try {
      await revokeOAuthClient(client.id);
      setFlash({
        tone: "ok",
        text: `${client.displayName} was revoked. Tokens it issued die with it.`,
      });
      setConfirmId(null);
      setRotated(null);
      void load();
    } catch (caught) {
      setFlash({ tone: "err", text: identityErrorText(caught) });
    } finally {
      setBusyId(null);
    }
  }

  if (!session) {
    return (
      <ConnectIdentityNote
        online={online}
        what="The service identities this principal owns"
      />
    );
  }

  return (
    <>
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>OAuth clients</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void load()}
            disabled={!online}
            title="Reload clients"
            aria-label="Reload clients"
          >
            <IconRefresh />
          </button>
        </div>

        <div className="panel__body">
          {error ? (
            <p className="note note--err" role="alert">
              <IconAlert /> {error}
            </p>
          ) : null}

          {clients === null && !error ? (
            <output className="note">Asking Identity…</output>
          ) : null}

          {clients && clients.length > 0 ? (
            <ul className="identity-rows">
              {clients.map((client) => (
                <li className="identity-row" key={client.id}>
                  <div className="identity-row__main">
                    <span className="identity-row__mark">
                      <IconAgent size={18} />
                    </span>
                    <div className="identity-row__id">
                      <h3>{client.displayName}</h3>
                      <code className="identity-ref">{client.id}</code>
                    </div>
                    <span className="chip">{client.admissionMode}</span>
                    <span
                      className={`chip ${
                        client.state === "active" ? "chip--ok" : "chip--warn"
                      }`}
                    >
                      {client.state}
                    </span>
                    <span className="identity-row__when">
                      created {formatTime(client.createdAt)}
                    </span>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={busyId !== null || !online}
                        onClick={() => void rotate(client)}
                      >
                        {busyId === client.id ? "Rotating…" : "Rotate secret"}
                      </button>
                      {confirmId === client.id ? (
                        <>
                          <button
                            type="button"
                            className="btn btn--sm btn--danger"
                            disabled={busyId !== null || !online}
                            onClick={() => void revoke(client)}
                          >
                            Revoke it
                          </button>
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => setConfirmId(null)}
                          >
                            Keep it
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--sm btn--danger"
                          disabled={busyId !== null || !online}
                          onClick={() => setConfirmId(client.id)}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </div>
                  {confirmId === client.id ? (
                    <p className="hint">
                      Revoking is immediate: every token this client minted is
                      refused from that moment.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {clients && clients.length === 0 ? (
            <div className="empty">
              <h3>No service identities.</h3>
            </div>
          ) : null}

          {rotated ? (
            <output className="note note--ok">
              <IconCheck />
              <p>
                Rotated — the new client id is shown once:{" "}
                <code>{rotated.id}</code>{" "}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => copy(rotated.id, "rotated")}
                  title="Copy new client id"
                  aria-label="Copy new client id"
                >
                  {copied === "rotated" ? <IconCheck /> : <IconCopy />}
                </button>{" "}
                The previous client id is revoked.
              </p>
            </output>
          ) : null}

          {flash ? (
            <output className={`note note--${flash.tone}`}>
              {flash.tone === "ok" ? <IconCheck /> : <IconAlert />}
              <p>{flash.text}</p>
            </output>
          ) : null}
        </div>
      </section>

      <CreateClientForm
        online={online}
        onCreated={() => void load()}
        onFlash={setFlash}
      />

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Agents</h2>
          </div>
        </div>
        <div className="panel__body">
          <div className="actions">
            <Link className="btn" to="/access">
              Open Access → Resources
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

function CreateClientForm({
  online,
  onCreated,
  onFlash,
}: {
  online: boolean;
  onCreated: () => void;
  onFlash: (flash: Flash) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [redirectUris, setRedirectUris] = useState("");
  const [sectorIdentifier, setSectorIdentifier] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const uris = redirectUris
      .split("\n")
      .map((uri) => uri.trim())
      .filter((uri) => uri.length > 0);
    if (!displayName.trim() || uris.length === 0 || !sectorIdentifier.trim()) {
      onFlash({
        tone: "err",
        text: "A display name, at least one redirect URI, and a sector identifier are all required.",
      });
      return;
    }
    setBusy(true);
    try {
      const created = await createOAuthClient({
        displayName: displayName.trim(),
        redirectUris: uris,
        sectorIdentifier: sectorIdentifier.trim(),
      });
      onFlash({
        tone: "ok",
        text: `${created.displayName} registered as ${created.id}.`,
      });
      setDisplayName("");
      setRedirectUris("");
      setSectorIdentifier("");
      onCreated();
    } catch (caught) {
      onFlash({ tone: "err", text: identityErrorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Register a service identity</h2>
        </div>
      </div>

      <div className="panel__body">
        <form onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label className="label" htmlFor="identity-client-name">
              Display name
            </label>
            <input
              id="identity-client-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Release pipeline"
              maxLength={128}
              disabled={busy}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="identity-client-uris">
              Redirect URIs — one per line
            </label>
            <textarea
              id="identity-client-uris"
              value={redirectUris}
              onChange={(event) => setRedirectUris(event.target.value)}
              placeholder="https://ci.example.com/callback"
              rows={3}
              spellCheck={false}
              disabled={busy}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="identity-client-sector">
              Sector identifier
            </label>
            <input
              id="identity-client-sector"
              value={sectorIdentifier}
              onChange={(event) => setSectorIdentifier(event.target.value)}
              placeholder="https://ci.example.com"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
            <p className="hint">
              An https URL naming the sector pairwise subjects are computed for.
            </p>
          </div>
          <div className="actions actions--end">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !online}
              aria-busy={busy}
            >
              {busy ? "Registering…" : "Register client"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ organization */

/**
 * The tailnet analog: organizations this principal belongs to, with the
 * server-side IdP lock (ssoIssuer / samlIssuer) shown for what it is.
 */
function OrganizationPanel({
  online,
  session,
  onOpenPeople,
}: {
  online: boolean;
  session: IdentitySession | null;
  onOpenPeople: () => void;
}) {
  const [orgs, setOrgs] = useState<OrgMembership[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    const id = ++run.current;
    try {
      const rows = await listOrgMemberships();
      if (run.current !== id) return;
      setOrgs(rows);
      setError(null);
    } catch (caught) {
      if (run.current !== id) return;
      setOrgs(null);
      setError(identityErrorText(caught));
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void load();
  }, [load, session]);

  if (!session) {
    return (
      <ConnectIdentityNote
        online={online}
        what="The organizations this principal belongs to"
      />
    );
  }

  return (
    <>
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Organizations</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => void load()}
            disabled={!online}
            title="Reload organizations"
            aria-label="Reload organizations"
          >
            <IconRefresh />
          </button>
        </div>

        <div className="panel__body">
          {error ? (
            <p className="note note--err" role="alert">
              <IconAlert /> {error}
            </p>
          ) : null}

          {orgs === null && !error ? (
            <output className="note">Asking Identity…</output>
          ) : null}

          {orgs && orgs.length > 0 ? (
            <ul className="identity-rows">
              {orgs.map((org) => (
                <li className="identity-row" key={org.id}>
                  <div className="identity-row__main">
                    <span className="identity-row__mark">
                      <IconShield size={18} />
                    </span>
                    <div className="identity-row__id">
                      <h3>{org.displayName}</h3>
                      <code className="identity-ref">{org.slug}</code>
                    </div>
                    <span className="chip">{org.role}</span>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={onOpenPeople}
                      >
                        View people
                      </button>
                    </div>
                  </div>
                  {org.ssoIssuer || org.samlIssuer ? (
                    <p className="hint">
                      Server-side IdP lock:{" "}
                      <code>{org.ssoIssuer ?? org.samlIssuer}</code>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {orgs && orgs.length === 0 ? (
            <div className="empty">
              <h3>No organizations yet</h3>
            </div>
          ) : null}
        </div>
      </section>

      <CreateOrgForm online={online} onCreated={() => void load()} />
    </>
  );
}

function CreateOrgForm({
  online,
  onCreated,
}: {
  online: boolean;
  onCreated: () => void;
}) {
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [ssoIssuer, setSsoIssuer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setCreated(null);
    const normalized = slug.trim().toLowerCase();
    // The same shape the server enforces, checked here so a bad slug never
    // leaves the device.
    if (!ORG_SLUG_RE.test(normalized)) {
      setError(
        "Use a slug like acme-corp — lowercase letters, numbers, and dashes.",
      );
      return;
    }
    if (!displayName.trim()) {
      setError("Give the organization a display name.");
      return;
    }
    setBusy(true);
    try {
      const org = await createOrganization({
        slug: normalized,
        displayName: displayName.trim(),
        ...(ssoIssuer.trim() ? { ssoIssuer: ssoIssuer.trim() } : undefined),
      });
      setCreated(`${org.displayName} was created — you are its owner.`);
      setSlug("");
      setDisplayName("");
      setSsoIssuer("");
      onCreated();
    } catch (caught) {
      setError(identityErrorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Create an organization</h2>
        </div>
      </div>

      <div className="panel__body">
        <form onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label className="label" htmlFor="identity-org-slug">
              Slug
            </label>
            <input
              id="identity-org-slug"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder="acme-corp"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="identity-org-name">
              Display name
            </label>
            <input
              id="identity-org-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Acme Corp"
              maxLength={128}
              disabled={busy}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="identity-org-sso">
              SSO issuer (optional)
            </label>
            <input
              id="identity-org-sso"
              value={ssoIssuer}
              onChange={(event) => setSsoIssuer(event.target.value)}
              placeholder="https://login.acme.com"
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
            <p className="hint">
              The OIDC issuer this organization locks sign-ins to.
            </p>
          </div>

          {error ? (
            <p className="note note--err" role="alert">
              <IconAlert /> {error}
            </p>
          ) : null}
          {created ? (
            <output className="note note--ok">
              <IconCheck /> {created}
            </output>
          ) : null}

          <div className="actions actions--end">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || !online}
              aria-busy={busy}
            >
              {busy ? "Creating…" : "Create organization"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ no principal */

function ConnectIdentityNote({
  online,
  what,
}: {
  online: boolean;
  what: string;
}) {
  const { connecting, error, connect } = useConnect();

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Sign in to see this</h2>
        </div>
      </div>
      <div className="panel__body">
        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={connecting || !online}
            onClick={() => void connect()}
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
            <IconAlert /> {error}
          </p>
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
