/**
 * Setup step 2 — everything else, all of it optional.
 *
 * This was three screens: Host, Machine, Review. None of them is a question a
 * first-time visitor has, and two of them asked for self-hosted infrastructure
 * as if it were expected. They are still here, because an operator who *does*
 * run a Host or a daemon needs somewhere to say so on first run — but they are
 * rows that expand in place, closed by default, under a heading that says the
 * screen can be walked past.
 *
 * The write-out at the bottom is the whole of the old Review step: what setup
 * is about to save, including the rows left empty, because an operator who
 * chose to run without a Host should see the choice recorded rather than an
 * absence they have to infer.
 */

import { type ReactNode, useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import {
  IconAuthority,
  IconChevronRight,
  IconPhone,
  IconTerminal,
} from "../../components/Icons.js";
import { ConnectThisMachine } from "../../components/PlaneNote.js";
import {
  loadSettings,
  pageIsLoopback,
  saveSettings,
  shippedHostApi,
} from "../../lib/settings.js";
import type { SetupIdentityChoice } from "../../lib/setup.js";
import { setupProviderFor } from "./providers.js";

export const moreStepDependencies = {
  loadSettings,
  saveSettings,
  pageIsLoopback,
};

const TRAILING_SLASH = /\/$/;

function Expander({
  id,
  label,
  icon,
  summary,
  children,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  /** What this row already holds, so it can be read without opening it. */
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="alt__item">
      <button
        type="button"
        className="alt__btn"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="alt__mark" aria-hidden="true">
          {icon}
        </span>
        <span className="alt__grow">{label}</span>
        <span className="alt__state">{summary}</span>
        <span
          className={open ? "alt__chev is-open" : "alt__chev"}
          aria-hidden="true"
        >
          <IconChevronRight size={16} />
        </span>
      </button>
      {open ? (
        <div className="alt__body" id={id}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="wrote-list__row">
      <dt className="wrote-list__key">{label}</dt>
      <dd
        className={
          value ? "wrote-list__val" : "wrote-list__val wrote-list__val--off"
        }
      >
        {value ?? "not set"}
      </dd>
    </div>
  );
}

export function MoreStep({
  choice,
  provider,
}: {
  choice: SetupIdentityChoice;
  provider: string;
}) {
  const settings = moreStepDependencies.loadSettings();
  const [hostApi, setHostApi] = useState(settings.hostApi);
  const [mfaAppUrl, setMfaAppUrl] = useState(settings.mfaAppUrl);
  // Pairing writes settings behind our back, so the write-out re-reads on the
  // ceremony's own signal rather than trusting the mount-time snapshot.
  const [revision, setRevision] = useState(0);
  const live = revision === 0 ? settings : moreStepDependencies.loadSettings();

  const shipped = moreStepDependencies.pageIsLoopback() ? shippedHostApi : "";
  const preset = setupProviderFor(provider);

  function commit(key: "hostApi" | "mfaAppUrl", raw: string) {
    const next = raw.trim().replace(TRAILING_SLASH, "");
    if (key === "hostApi") setHostApi(next);
    else setMfaAppUrl(next);
    const current = moreStepDependencies.loadSettings();
    if (current[key] === next) return;
    moreStepDependencies.saveSettings({ ...current, [key]: next });
    setRevision((value) => value + 1);
  }

  const signInSummary =
    choice === "none"
      ? "no accounts"
      : choice === "byo"
        ? (preset?.label ?? "your own provider")
        : "brokered";

  return (
    <div className="setup__stack">
      <div className="alt">
        <Expander
          id="setup-more-host"
          label="Host"
          icon={<IconAuthority size={18} />}
          summary={hostApi.trim() ? "set" : "none"}
        >
          <p className="hint">
            The authority plane — it authorizes every ConnectionRef and signs
            every receipt. Without one the vault still holds your own items;
            what you lose is connectors and anything agent-facing.
          </p>
          <FieldShell
            id="setup-host-api"
            label="Host API"
            type="url"
            mono
            lead={<IconAuthority size={17} />}
            placeholder="https://host.example.com"
            value={hostApi}
            onValueChange={setHostApi}
            onCommit={(value) => commit("hostApi", value)}
            fills={
              shipped && hostApi.trim() !== shipped
                ? [
                    {
                      label: shipped,
                      onPick: () => commit("hostApi", shipped),
                    },
                  ]
                : []
            }
          />
        </Expander>

        <Expander
          id="setup-more-machine"
          label="This machine"
          icon={<IconTerminal size={18} />}
          summary={live.daemonApi.trim() ? "paired" : "not paired"}
        >
          <p className="hint">
            Only if you run OpenSesame on your own machine. A static deployment
            cannot call <code>127.0.0.1</code>, so a daemon on your tailnet
            stands in for it — and pairing writes the Host and identity
            addresses with it.
          </p>
          <ConnectThisMachine onPaired={() => setRevision((v) => v + 1)} />
        </Expander>

        <Expander
          id="setup-more-mfa"
          label="Mobile MFA app"
          icon={<IconPhone size={18} />}
          summary={mfaAppUrl.trim() ? "set" : "none"}
        >
          <p className="hint">
            When this browser cannot finish a passkey, the passkey note shows a
            QR that opens this URL on your phone.
          </p>
          <FieldShell
            id="setup-mfa-app"
            label="Mobile MFA app"
            type="url"
            mono
            lead={<IconPhone size={17} />}
            placeholder="https://mfa.example.com"
            value={mfaAppUrl}
            onValueChange={setMfaAppUrl}
            onCommit={(value) => commit("mfaAppUrl", value)}
          />
        </Expander>
      </div>

      <dl className="wrote-list">
        <Row label="Sign-in" value={signInSummary} />
        <Row label="Identity service" value={live.identityApi.trim() || null} />
        <Row label="Host API" value={live.hostApi.trim() || null} />
        <Row label="This machine" value={live.daemonApi.trim() || null} />
        <Row label="Mobile MFA app" value={live.mfaAppUrl.trim() || null} />
      </dl>

      <p className="hint">
        All of this is saved on this device only — they are addresses, not
        credentials, and nothing has been sent anywhere. Change any of it later
        under Settings → Endpoints.
      </p>
    </div>
  );
}
