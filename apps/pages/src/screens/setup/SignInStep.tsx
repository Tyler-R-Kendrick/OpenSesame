/**
 * Setup step 1 — how do people sign in here?
 *
 * The first version of this step asked for an OpenSesame identity service URL
 * before anything else, which had the dependency exactly backwards. A browser
 * can run the whole code flow itself against a `browserCapable` upstream, and
 * `TRUSTED_UPSTREAMS` compiles one into every build — so **sign-in already
 * works on a deployment nobody has configured**. Demanding a self-hosted
 * address first made the common case walk past a field it had no answer for,
 * to reach a service it did not need.
 *
 * So the question is the choice, and the infrastructure appears only for the
 * answer that actually requires it:
 *
 *  - **Keep what this deployment brokers** — zero config, selected by default.
 *  - **Bring your own provider** — WorkOS, Okta, Auth0, Better Auth, any OIDC
 *    issuer. A browser cannot speak those legs, so this is the one road that
 *    needs an identity service, and it asks for one *here*, in place.
 *  - **No accounts** — a local vault, sealed on this device.
 *
 * The OpenSesame identity service is therefore one option among the providers,
 * never a prerequisite for them.
 */

import { useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import {
  IconCheck,
  IconLock,
  IconLogin,
  IconSite,
  IconUser,
} from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import { ByoError, registerByoProvider } from "../../lib/byo.js";
import { defaultUpstream } from "../../lib/federation.js";
import {
  loadSettings,
  pageIsLoopback,
  saveSettings,
  shippedIdentityApi,
} from "../../lib/settings.js";
import type { SetupIdentityChoice } from "../../lib/setup.js";
import { SETUP_PROVIDERS, setupProviderFor } from "./providers.js";

export const signInStepDependencies = {
  loadSettings,
  saveSettings,
  pageIsLoopback,
  registerByoProvider,
  defaultUpstream,
};

const TRAILING_SLASH = /\/$/;

type Road = {
  id: SetupIdentityChoice;
  label: string;
  kind: string;
  icon: typeof IconLogin;
};

type Props = {
  choice: SetupIdentityChoice;
  onChoiceChange: (choice: SetupIdentityChoice) => void;
  /** The provider preset registered so far, or "" for none. */
  provider: string;
  onProviderChange: (provider: string) => void;
};

export function SignInStep({
  choice,
  onChoiceChange,
  provider,
  onProviderChange,
}: Props) {
  const [identityApi, setIdentityApi] = useState(
    () => signInStepDependencies.loadSettings().identityApi,
  );
  const [chosenProvider, setChosenProvider] = useState<string | null>(null);
  const [issuerInput, setIssuerInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{
    tone: "ok" | "warn" | "err";
    text: string;
  } | null>(null);

  const upstream = signInStepDependencies.defaultUpstream();
  const connected = identityApi.trim().length > 0;
  const preset = chosenProvider ? setupProviderFor(chosenProvider) : null;
  const shipped = signInStepDependencies.pageIsLoopback()
    ? shippedIdentityApi
    : "";

  const roads: Road[] = [
    {
      id: "brokered",
      // Named, not described: "Google (via shoo.dev)" is what the button on the
      // sign-in screen will actually say, so the choice and its consequence
      // read the same. Sentence-cased because `accountKind` is written to sit
      // mid-sentence ("Continue with a test account") and this is a title.
      label:
        upstream.accountKind.charAt(0).toUpperCase() +
        upstream.accountKind.slice(1),
      kind: "ready — nothing to set up",
      icon: IconLogin,
    },
    {
      id: "byo",
      label: "Your own provider",
      kind: "WorkOS, Okta, Auth0, OIDC",
      icon: IconSite,
    },
    {
      id: "none",
      label: "No accounts",
      kind: "local vault only",
      icon: IconLock,
    },
  ];

  function commitIdentity(raw: string) {
    const next = raw.trim().replace(TRAILING_SLASH, "");
    setIdentityApi(next);
    const current = signInStepDependencies.loadSettings();
    if (current.identityApi === next) return;
    signInStepDependencies.saveSettings({ ...current, identityApi: next });
    if (provider) {
      onProviderChange("");
      setFlash({
        tone: "warn",
        text: "Identity service changed. Register your provider again against the new one.",
      });
    }
  }

  function register() {
    if (!preset) return;
    const built = preset.issuerFor(issuerInput);
    if (!built.ok) {
      setFlash({ tone: "err", text: built.error });
      return;
    }
    setBusy(true);
    setFlash(null);
    void (async () => {
      try {
        const registration = await signInStepDependencies.registerByoProvider({
          issuer: built.issuer,
        });
        onProviderChange(preset.id);
        setFlash({
          tone: "ok",
          text: `${registration.label} registered. It will appear on the sign-in screen.`,
        });
      } catch (caught) {
        setFlash({
          tone: "err",
          text:
            caught instanceof ByoError
              ? caught.message
              : caught instanceof Error
                ? caught.message
                : "That provider could not be registered.",
        });
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <div className="setup__stack">
      {/* Real radios inside labels, not buttons wearing `role="radio"`: the
          arrow-key navigation and the group semantics come from the element,
          and the input is only visually replaced by the card around it. */}
      <fieldset className="road">
        <legend className="road__legend">How people sign in</legend>
        {roads.map((road) => {
          const on = choice === road.id;
          const Glyph = road.icon;
          return (
            <label
              key={road.id}
              className={on ? "road__opt is-on" : "road__opt"}
            >
              <input
                type="radio"
                name="setup-signin-road"
                className="road__input"
                value={road.id}
                checked={on}
                onChange={() => {
                  onChoiceChange(road.id);
                  setFlash(null);
                }}
              />
              <span className="road__mark" aria-hidden="true">
                <Glyph size={18} />
              </span>
              <span className="road__body">
                <span className="road__name">{road.label}</span>
                <span className="road__kind">{road.kind}</span>
              </span>
              {on ? (
                <span className="road__on" aria-hidden="true">
                  <IconCheck size={16} />
                </span>
              ) : null}
            </label>
          );
        })}
      </fieldset>

      {choice === "brokered" ? (
        <p className="hint">
          This build already brokers a sign-in that runs entirely in the
          browser, so there is nothing to run and no address to type. People
          sign in the moment they open the app.
        </p>
      ) : null}

      {choice === "none" ? (
        <p className="hint">
          Everything stays on this device, sealed with a passkey, PIN, or
          password. No sync between devices, and no recovery — the vault is only
          as durable as this browser's storage.
        </p>
      ) : null}

      {choice === "byo" ? (
        <div className="setup__stack">
          <p className="hint">
            A browser cannot speak these providers' legs directly, so they run
            server-side. Point at an OpenSesame identity service — one you run,
            or one someone runs for you — and register the provider through it.
          </p>

          <FieldShell
            id="setup-identity-api"
            label="Identity service"
            type="url"
            mono
            lead={<IconUser size={17} />}
            placeholder="https://id.example.com"
            value={identityApi}
            status={
              connected ? (
                <span className="chip chip--ok">Will connect</span>
              ) : (
                <span className="chip">Needed for this road</span>
              )
            }
            onValueChange={setIdentityApi}
            onCommit={commitIdentity}
            fills={
              shipped && identityApi.trim() !== shipped
                ? [{ label: shipped, onPick: () => commitIdentity(shipped) }]
                : []
            }
            hint="Saved on this device only, and never sent anywhere else."
          />

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
                disabled={!connected || busy}
                onClick={() => {
                  setChosenProvider(entry.id);
                  setIssuerInput("");
                  setFlash(null);
                }}
              >
                <span className="preset__name">{entry.label}</span>
                <span className="preset__kind">{entry.kind}</span>
              </button>
            ))}
          </div>

          {connected ? null : (
            <p className="hint">
              Set the identity service first — the provider is registered
              through it, so there is nowhere to send one yet.
            </p>
          )}

          {preset?.field ? (
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
          ) : null}

          {chosenProvider === "workos" ? (
            <p className="hint">
              AuthKit's issuer is fixed at <code>api.workos.com</code> for every
              deployment — there is nothing to type.
            </p>
          ) : null}

          {chosenProvider ? (
            <div className="actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={
                  busy || (Boolean(preset?.field) && !issuerInput.trim())
                }
                aria-busy={busy}
                onClick={register}
              >
                {busy ? "Checking…" : `Register ${preset?.label ?? "provider"}`}
              </button>
            </div>
          ) : null}

          <StatusNote message={flash} />
        </div>
      ) : null}
    </div>
  );
}
