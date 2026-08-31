/**
 * Setup step 2 — is there a Host?
 *
 * The authority plane is genuinely optional for a human vault, and saying so
 * plainly is the point of this step: an operator who leaves it empty has made
 * a choice, not skipped a required field. What they lose is stated once, in
 * the terms the rest of the product uses — ConnectionRefs, receipts, the
 * agent-facing surface — rather than as "some features may not work".
 *
 * The alternative row is the shorter road for anyone running OpenSesame on
 * their own machine: pairing a daemon on the next step writes this address
 * (and the Identity one) for them, so it hands over rather than duplicating
 * the pairing ceremony here.
 */

import { useState } from "react";
import { FieldShell } from "../../components/FieldShell.js";
import {
  IconAuthority,
  IconChevronRight,
  IconTerminal,
} from "../../components/Icons.js";
import {
  loadSettings,
  pageIsLoopback,
  saveSettings,
  shippedHostApi,
} from "../../lib/settings.js";

export const hostStepDependencies = {
  loadSettings,
  saveSettings,
  pageIsLoopback,
};

const TRAILING_SLASH = /\/$/;

export function HostStep({ onPairInstead }: { onPairInstead: () => void }) {
  const [hostApi, setHostApi] = useState(
    () => hostStepDependencies.loadSettings().hostApi,
  );
  const [open, setOpen] = useState(false);

  const connected = hostApi.trim().length > 0;
  const shipped = hostStepDependencies.pageIsLoopback() ? shippedHostApi : "";

  function commit(raw: string) {
    const next = raw.trim().replace(TRAILING_SLASH, "");
    setHostApi(next);
    const current = hostStepDependencies.loadSettings();
    if (current.hostApi === next) return;
    hostStepDependencies.saveSettings({ ...current, hostApi: next });
  }

  return (
    <div className="setup__stack">
      <FieldShell
        id="setup-host-api"
        label="Host API"
        type="url"
        mono
        lead={<IconAuthority size={17} />}
        placeholder="https://host.example.com"
        value={hostApi}
        status={
          connected ? (
            <span className="chip chip--ok">Will connect</span>
          ) : (
            <span className="chip">Optional</span>
          )
        }
        onValueChange={setHostApi}
        onCommit={commit}
        fills={
          shipped && hostApi.trim() !== shipped
            ? [{ label: shipped, onPick: () => commit(shipped) }]
            : []
        }
      />

      <p className="note">
        <span>
          Leave this empty and the vault still works. Without a Host there are
          no ConnectionRefs, no receipts, and no agent-facing authority — human
          items only.
        </span>
      </p>

      <p className="or">
        <span>or</span>
      </p>

      <div className="alt">
        <div className="alt__item">
          <button
            type="button"
            className="alt__btn"
            aria-expanded={open}
            aria-controls="setup-host-pair"
            onClick={() => setOpen((value) => !value)}
          >
            <span className="alt__mark" aria-hidden="true">
              <IconTerminal size={18} />
            </span>
            <span className="alt__grow">Let a paired daemon front it</span>
            <span
              className={open ? "alt__chev is-open" : "alt__chev"}
              aria-hidden="true"
            >
              <IconChevronRight size={16} />
            </span>
          </button>
          {open ? (
            <div className="alt__body" id="setup-host-pair">
              <p className="hint">
                Pairing a daemon on the next step writes its Host and Identity
                addresses too. If you are running OpenSesame on your own
                machine, that is the shorter road — leave this field empty.
              </p>
              <div className="actions">
                <button type="button" className="btn" onClick={onPairInstead}>
                  Go to pairing
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
