/**
 * Setup step 4 — what is about to be written.
 *
 * Every row is stated, including the ones left empty: an operator who chose to
 * run without a Host should see that choice recorded, not an absence they have
 * to infer. The values are addresses, not credentials — nothing on this screen
 * has left the device, and the last line says so, because a first-run form
 * that asks for four URLs and then goes quiet invites exactly the wrong guess.
 *
 * The remaining endpoint that has no step of its own lives behind the
 * disclosure. It is real setup — the Mobile MFA app is how a browser that
 * cannot finish a passkey hands the ceremony to a phone — but it is the answer
 * to a question almost nobody has on first run.
 */

import { useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import { IconChevronRight, IconPhone } from "../../components/Icons.js";
import { loadSettings, saveSettings } from "../../lib/settings.js";
import { setupProviderFor } from "./providers.js";

export const reviewStepDependencies = {
  loadSettings,
  saveSettings,
};

const TRAILING_SLASH = /\/$/;

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

export function ReviewStep({ provider }: { provider: string }) {
  const settings = reviewStepDependencies.loadSettings();
  const [mfaAppUrl, setMfaAppUrl] = useState(settings.mfaAppUrl);
  const [open, setOpen] = useState(false);

  // Looked up rather than cast: `provider` is whatever the identity step
  // recorded, and an option that no longer exists must read as "none".
  const preset = setupProviderFor(provider);

  function commitMfa(raw: string) {
    const next = raw.trim().replace(TRAILING_SLASH, "");
    setMfaAppUrl(next);
    const current = reviewStepDependencies.loadSettings();
    if (current.mfaAppUrl === next) return;
    reviewStepDependencies.saveSettings({ ...current, mfaAppUrl: next });
  }

  return (
    <div className="setup__stack">
      <dl className="wrote-list">
        <Row label="Identity API" value={settings.identityApi.trim() || null} />
        <Row label="Sign-in provider" value={preset ? preset.label : null} />
        <Row label="Host API" value={settings.hostApi.trim() || null} />
        <Row label="This machine" value={settings.daemonApi.trim() || null} />
        <Row label="Mobile MFA app" value={mfaAppUrl.trim() || null} />
      </dl>

      <div className="alt">
        <div className="alt__item">
          <button
            type="button"
            className="alt__btn"
            aria-expanded={open}
            aria-controls="setup-more-endpoints"
            onClick={() => setOpen((value) => !value)}
          >
            <span className="alt__mark" aria-hidden="true">
              <IconPhone size={18} />
            </span>
            <span className="alt__grow">More endpoints</span>
            <span
              className={open ? "alt__chev is-open" : "alt__chev"}
              aria-hidden="true"
            >
              <IconChevronRight size={16} />
            </span>
          </button>
          {open ? (
            <div className="alt__body" id="setup-more-endpoints">
              <FieldShell
                id="setup-mfa-app"
                label="Mobile MFA app"
                type="url"
                mono
                lead={<IconPhone size={17} />}
                placeholder="https://mfa.example.com"
                value={mfaAppUrl}
                onValueChange={setMfaAppUrl}
                onCommit={commitMfa}
                hint="When this browser cannot finish a passkey, the passkey note shows a QR that opens this URL on your phone."
              />
            </div>
          ) : null}
        </div>
      </div>

      <p className="hint">
        All of this is saved on this device only — they are addresses, not
        credentials, and nothing has been sent anywhere. Change any of it later
        under Settings → Endpoints.
      </p>
    </div>
  );
}
