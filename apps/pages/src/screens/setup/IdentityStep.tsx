/**
 * Setup step 1 — where identity lives.
 *
 * Two questions, in the only order they can be asked. The **Identity API** is
 * an OpenSesame deployment's own identity plane, and sign-in of any kind is
 * impossible without it. An **upstream provider** — Better Auth, WorkOS, Okta,
 * Auth0, or any other OIDC issuer — is registered *through* that API by
 * SSRF-fenced discovery and RFC 7591 dynamic client registration (ADR 0055 /
 * 0060), so the address has to exist before the preset grid means anything.
 * The grid is therefore disabled until it does, rather than accepting an
 * issuer it has nowhere to send.
 *
 * Nothing here invents a second registration path: `presetIssuer` and
 * `registerByoProvider` are the same functions the Identity ceremony and the
 * sign-in sheet already call.
 */

import { useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import { IconLogin, IconSite } from "../../components/Icons.js";
import { StatusNote } from "../../components/StatusNote.js";
import { ByoError, registerByoProvider } from "../../lib/byo.js";
import {
  loadSettings,
  pageIsLoopback,
  saveSettings,
  shippedIdentityApi,
} from "../../lib/settings.js";
import { SETUP_PROVIDERS, setupProviderFor } from "./providers.js";

export const identityStepDependencies = {
  loadSettings,
  saveSettings,
  pageIsLoopback,
  registerByoProvider,
};

const TRAILING_SLASH = /\/$/;

type Props = {
  /** The provider preset registered so far, or "" for none. */
  provider: string;
  onProviderChange: (provider: string) => void;
};

export function IdentityStep({ provider, onProviderChange }: Props) {
  const [identityApi, setIdentityApi] = useState(
    () => identityStepDependencies.loadSettings().identityApi,
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const [issuerInput, setIssuerInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{
    tone: "ok" | "warn" | "err";
    text: string;
  } | null>(null);

  const connected = identityApi.trim().length > 0;
  const preset = chosen ? setupProviderFor(chosen) : null;
  const shipped = identityStepDependencies.pageIsLoopback()
    ? shippedIdentityApi
    : "";

  function commitIdentity(raw: string) {
    const next = raw.trim().replace(TRAILING_SLASH, "");
    setIdentityApi(next);
    const current = identityStepDependencies.loadSettings();
    if (current.identityApi === next) return;
    identityStepDependencies.saveSettings({ ...current, identityApi: next });
    // A changed Identity API invalidates a registration made against the old
    // one — say so rather than leaving a stale "Registered" chip on screen.
    if (provider) {
      onProviderChange("");
      setFlash({
        tone: "warn",
        text: "Identity API changed. Register your provider again against the new one.",
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
        const registration = await identityStepDependencies.registerByoProvider(
          {
            issuer: built.issuer,
          },
        );
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
      <FieldShell
        id="setup-identity-api"
        label="Identity API"
        type="url"
        mono
        lead={<IconLogin size={17} />}
        placeholder="https://id.example.com"
        value={identityApi}
        status={
          connected ? (
            <span className="chip chip--ok">Will connect</span>
          ) : (
            <span className="chip">Not set</span>
          )
        }
        onValueChange={setIdentityApi}
        onCommit={commitIdentity}
        fills={
          shipped && identityApi.trim() !== shipped
            ? [{ label: shipped, onPick: () => commitIdentity(shipped) }]
            : []
        }
        hint="Where sign-in happens. Ask whoever runs your OpenSesame deployment — it is saved on this device only, and never sent anywhere else."
      />

      <p className="or">
        <span>then, optionally</span>
      </p>

      <div className="setup__stack">
        <h2>Your organization's sign-in</h2>
        <p className="hint">
          Registered through the Identity API above by OIDC discovery. Skip it
          and people sign in with whatever this deployment already brokers.
        </p>

        <div className="preset">
          {SETUP_PROVIDERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={
                chosen === entry.id ? "preset__opt is-on" : "preset__opt"
              }
              aria-pressed={chosen === entry.id}
              disabled={!connected || busy}
              onClick={() => {
                setChosen(entry.id);
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
            Set an Identity API first — a provider is registered through it, so
            there is nowhere to send one yet.
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

        {chosen === "workos" ? (
          <p className="hint">
            AuthKit's issuer is fixed at <code>api.workos.com</code> for every
            deployment — there is nothing to type.
          </p>
        ) : null}

        {chosen ? (
          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || (Boolean(preset?.field) && !issuerInput.trim())}
              aria-busy={busy}
              onClick={register}
            >
              {busy ? "Checking…" : `Register ${preset?.label ?? "provider"}`}
            </button>
          </div>
        ) : null}

        <StatusNote message={flash} />
      </div>
    </div>
  );
}
