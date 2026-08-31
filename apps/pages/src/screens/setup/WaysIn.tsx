/**
 * The whole of first-run setup: who signs people in here?
 *
 * The screen is an **allowlist being built**, not a single choice. A
 * deployment usually wants more than one way in — Google for most people, an
 * Okta org for staff — so the operator adds as many providers as they like,
 * and the sign-in screen then offers exactly those and nothing else. A road
 * nobody configured is not a road; offering it anyway is the dead end this
 * whole rework exists to remove.
 *
 * Three kinds of way in, and each is complete on its own:
 *
 *  - **What this build brokers.** Present on arrival and removable.
 *    `TRUSTED_UPSTREAMS` compiles a browser-capable upstream into every build,
 *    so a deployment nobody has configured already signs people in.
 *  - **Providers the operator brings.** Google, Microsoft Entra ID, Okta,
 *    Auth0, WorkOS, Better Auth, any OIDC issuer — run *by this browser*, code
 *    flow with PKCE, against the provider's own discovery document (ADR 0078).
 *    An issuer plus a public client id, and it IS the identity service.
 *  - **An OpenSesame identity service.** A peer, never a prerequisite, for
 *    what a browser genuinely cannot do alone: org SSO and SAML, LDAP, email
 *    magic links, guest sessions, and whatever its own catalog brokers.
 *
 * Remove everything and that is a real answer too: a local vault, sealed on
 * this device, with no accounts at all.
 *
 * What is *not* asked: a Host API, and pairing a daemon on this machine.
 * Neither is a question a first-time visitor has, and neither gates anything
 * the vault does on its own — see ADR 0078 §4 for what the Host is actually
 * for. They live in Settings → Endpoints.
 */

import { useReducer, useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import {
  IconAuthority,
  IconCheck,
  IconCopy,
  IconLogin,
  IconSecret,
  IconSite,
  IconTrash,
} from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import {
  FederationError,
  defaultUpstream,
  discover,
  redirectUri,
} from "../../lib/federation.js";
import {
  type OperatorIdp,
  loadSettings,
  normalizeOperatorIdp,
  pageIsLoopback,
  saveSettings,
  shippedIdentityApi,
  signInMethods,
} from "../../lib/settings.js";
import { brandFor } from "../unlock/ProviderBrand.js";
import { SETUP_PROVIDERS, setupProviderFor } from "./providers.js";

export const waysInDependencies = {
  loadSettings,
  saveSettings,
  pageIsLoopback,
  defaultUpstream,
  discover,
  redirectUri,
};

const TRAILING_SLASH = /\/$/;

/** One row of the list: a way in, and the control that takes it away. */
type WayIn = {
  key: string;
  name: string;
  kind: string;
  brandId: string;
  remove: () => void;
};

/** What a single edit changes; everything unnamed is left as it stands. */
type WaysInPatch = {
  builtin?: boolean;
  providers?: OperatorIdp[];
  identityApi?: string;
};

export function WaysIn() {
  const [chosenProvider, setChosenProvider] = useState<string | null>(null);
  const [issuerInput, setIssuerInput] = useState("");
  const [clientIdInput, setClientIdInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [flash, setFlash] = useState<{
    tone: "ok" | "warn" | "err";
    text: string;
  } | null>(null);
  // Writes land in the settings store, not in this component's state, so a
  // bump is the only thing that has to be local: everything below re-reads the
  // store on every render and would otherwise show the pre-write value.
  const [, bump] = useReducer((count: number) => count + 1, 0);

  const settings = waysInDependencies.loadSettings();
  const methods = signInMethods(settings);
  const [identityApi, setIdentityApi] = useState(settings.identityApi);

  const upstream = waysInDependencies.defaultUpstream();
  const preset = chosenProvider ? setupProviderFor(chosenProvider) : null;
  const shippedLocal = waysInDependencies.pageIsLoopback()
    ? shippedIdentityApi
    : "";
  const callback = waysInDependencies.redirectUri();
  const service = identityApi.trim();

  function write(next: WaysInPatch) {
    const current = waysInDependencies.loadSettings();
    const live = signInMethods(current);
    waysInDependencies.saveSettings({
      ...current,
      identityApi: next.identityApi ?? current.identityApi,
      signIn: {
        builtin: next.builtin ?? live.builtin,
        providers: next.providers ?? live.providers,
      },
    });
    bump();
  }

  function commitIdentityApi(raw: string) {
    const value = raw.trim().replace(TRAILING_SLASH, "");
    setIdentityApi(value);
    if (waysInDependencies.loadSettings().identityApi === value) return;
    write({ identityApi: value });
  }

  /**
   * Verify and keep a provider.
   *
   * Discovery is the check: it proves the issuer exists, publishes an
   * authorization and token endpoint, and names itself honestly. Saving a
   * provider we could not reach would be re-creating the bug this whole screen
   * exists to remove — a deployment that reads as configured and dead-ends at
   * the first sign-in.
   */
  function addProvider() {
    if (!preset) return;
    const built = preset.issuerFor(issuerInput);
    if (!built.ok) {
      setFlash({ tone: "err", text: built.error });
      return;
    }
    const idp = normalizeOperatorIdp(
      preset.brandId || preset.id,
      built.issuer,
      clientIdInput,
      preset.label,
    );
    if (!idp) {
      setFlash({
        tone: "err",
        text: "That needs both an issuer and a client id.",
      });
      return;
    }
    if (methods.providers.some((entry) => entry.issuer === idp.issuer)) {
      setFlash({
        tone: "warn",
        text: `${idp.label} is already a way in. Remove it first to change its client id.`,
      });
      return;
    }
    setBusy(true);
    setFlash(null);
    void (async () => {
      try {
        await waysInDependencies.discover(idp.issuer);
        write({
          providers: [...signInMethods().providers, idp],
        });
        setChosenProvider(null);
        setIssuerInput("");
        setClientIdInput("");
        setFlash({
          tone: "ok",
          text: `${idp.label} added. It will be on the sign-in screen.`,
        });
      } catch (caught) {
        setFlash({
          tone: "err",
          text:
            caught instanceof FederationError || caught instanceof Error
              ? caught.message
              : "That issuer could not be reached.",
        });
      } finally {
        setBusy(false);
      }
    })();
  }

  function removeProvider(issuer: string) {
    write({
      providers: signInMethods().providers.filter(
        (entry) => entry.issuer !== issuer,
      ),
    });
    setFlash(null);
  }

  function copyCallback() {
    void navigator.clipboard?.writeText(callback).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        // A refused clipboard is not worth an error state: the URI is on
        // screen in full, and selecting it by hand still works.
      },
    );
  }

  const ways: WayIn[] = [
    ...(methods.builtin
      ? [
          {
            key: "builtin",
            // Sentence-cased: `accountKind` is written to sit mid-sentence
            // ("Continue with a test account") and this is a title.
            name:
              upstream.accountKind.charAt(0).toUpperCase() +
              upstream.accountKind.slice(1),
            kind: "built in — nothing to set up",
            brandId: upstream.id,
            remove: () => write({ builtin: false }),
          },
        ]
      : []),
    ...methods.providers.map((idp) => ({
      key: idp.issuer,
      name: idp.label,
      kind: new URL(idp.issuer).hostname,
      brandId: idp.providerId,
      remove: () => removeProvider(idp.issuer),
    })),
    ...(service
      ? [
          {
            key: "service",
            // No article: this name also fills "Remove {name}".
            name: "OpenSesame identity service",
            kind: service.replace(/^https?:\/\//, ""),
            brandId: "",
            remove: () => commitIdentityApi(""),
          },
        ]
      : []),
  ];

  return (
    <div className="setup__stack">
      <div className="ways">
        <p className="ways__head">
          Ways in
          <span className="ways__count">{ways.length}</span>
        </p>
        {ways.length === 0 ? (
          <p className="hint">
            None — this deployment would open a local vault only, sealed on this
            device with a passkey, PIN, or password. No sync between devices,
            and no recovery. That is a real answer; add a way in below to change
            it.
          </p>
        ) : (
          <ul className="ways__list">
            {ways.map((way) => {
              const brand = way.brandId ? brandFor(way.brandId) : null;
              return (
                <li className="ways__item" key={way.key}>
                  <span className="ways__mark" aria-hidden="true">
                    {brand ? <brand.Icon size={18} /> : <IconLogin size={18} />}
                  </span>
                  <span className="ways__body">
                    <span className="ways__name">{way.name}</span>
                    <span className="ways__kind">{way.kind}</span>
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${way.name}`}
                    title={`Remove ${way.name}`}
                    onClick={way.remove}
                  >
                    <IconTrash size={17} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="setup__stack">
        <p className="ways__head">Add a provider</p>
        <p className="hint">
          This browser runs the whole sign-in itself — authorization code with
          PKCE, against the provider's own discovery document. Register this app
          there as a single-page or public client, then name it here.
        </p>

        <div className="preset">
          {SETUP_PROVIDERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={
                chosenProvider === entry.id
                  ? "preset__opt is-on"
                  : "preset__opt"
              }
              aria-pressed={chosenProvider === entry.id}
              disabled={busy}
              onClick={() => {
                setChosenProvider(entry.id);
                setIssuerInput("");
                setClientIdInput("");
                setFlash(null);
              }}
            >
              <span className="preset__name">{entry.label}</span>
              <span className="preset__kind">{entry.kind}</span>
            </button>
          ))}
        </div>

        {preset ? (
          <>
            <FieldShell
              id="setup-callback"
              label="Redirect URI to register"
              type="url"
              mono
              readOnly
              lead={<IconSite size={17} />}
              value={callback}
              tail={
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Copy the redirect URI"
                  title="Copy the redirect URI"
                  onClick={copyCallback}
                >
                  {copied ? <IconCheck size={17} /> : <IconCopy size={17} />}
                </button>
              }
              hint="Paste this into the provider's allowed redirect URIs, exactly as shown."
            />

            {preset.field ? (
              <FieldShell
                id="setup-issuer"
                label={preset.field.label}
                type="text"
                mono
                lead={<IconSite size={17} />}
                placeholder={preset.field.placeholder}
                value={issuerInput}
                disabled={busy}
                onValueChange={setIssuerInput}
                hint={preset.field.hint}
              />
            ) : (
              <p className="hint">
                {preset.id === "workos"
                  ? "AuthKit's issuer is fixed at api.workos.com for every deployment — there is nothing to type."
                  : "Google publishes one issuer for everybody — there is nothing to type."}
              </p>
            )}

            <FieldShell
              id="setup-client-id"
              label="Client ID"
              type="text"
              mono
              lead={<IconSecret size={17} />}
              placeholder="0oa1b2c3d4EXAMPLE"
              value={clientIdInput}
              disabled={busy}
              onValueChange={setClientIdInput}
              hint={preset.clientIdHint}
            />

            <div className="actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={
                  busy ||
                  !clientIdInput.trim() ||
                  (Boolean(preset.field) && !issuerInput.trim())
                }
                aria-busy={busy}
                onClick={addProvider}
              >
                {busy ? "Checking…" : `Add ${preset.label}`}
              </button>
            </div>
          </>
        ) : null}

        <StatusNote message={flash} />
      </div>

      <div className="setup__stack">
        <p className="ways__head">Or an OpenSesame identity service</p>
        <p className="hint">
          One you run, or one someone runs for you. It brings the roads a
          browser cannot walk on its own: organisation SSO and SAML, LDAP, email
          magic links, guest sessions, and whatever providers it brokers itself.
        </p>
        <FieldShell
          id="setup-identity-api"
          label="Identity service"
          type="url"
          mono
          lead={<IconAuthority size={17} />}
          placeholder="https://id.example.com"
          value={identityApi}
          status={
            service ? <span className="chip chip--ok">Will connect</span> : null
          }
          onValueChange={setIdentityApi}
          onCommit={commitIdentityApi}
          fills={
            shippedLocal && identityApi.trim() !== shippedLocal
              ? [
                  {
                    label: shippedLocal,
                    onPick: () => commitIdentityApi(shippedLocal),
                  },
                ]
              : []
          }
          hint="Optional. Saved on this device only, and never sent anywhere else."
        />
      </div>

      <p className="hint">
        Saved on this device only — an issuer and a public client id are
        configuration, not credentials, and nothing has been sent anywhere. The
        sign-in screen offers exactly what is listed above. Change any of it
        later under Settings → Endpoints.
      </p>
    </div>
  );
}
