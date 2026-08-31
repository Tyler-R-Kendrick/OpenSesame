/**
 * The first-run setup ceremony — one screen, one question.
 *
 * What this replaces, in order:
 *
 *  1. A block of amber above the unlock form, reporting that the deployment
 *     had no identity service and offering a text field for an address the
 *     reader had never been given — above sign-in options that could not work
 *     and an Unlock tab for a vault that did not exist.
 *  2. Four steps that led with an OpenSesame identity service URL, a Host URL
 *     and a daemon on the operator's own machine.
 *  3. Two steps, which only moved that same self-hosted plumbing behind a
 *     road and a fold. Bringing WorkOS or Okta still meant standing up an
 *     OpenSesame control plane first, and the readout still said
 *     `Identity service — not set` for a deployment that signed people in.
 *
 * There is exactly one thing this app cannot work out for itself: who signs
 * people in. Everything that used to share the ceremony with that question —
 * a Host API, pairing this machine, a mobile MFA URL — is either optional
 * infrastructure or a preference, and all of it already lives in Settings →
 * Endpoints. None of it belongs in front of a first-time visitor. See ADR
 * 0078 §4 for what the Host is actually for, and why nothing here waits on it.
 *
 * So: no stepper, no counter, no skip, no back. A question, its roads, and
 * the terminal commit at the bottom of the phone as the shared `.go` control —
 * an ink square carrying the glyph of what it does, its sentence beside it.
 * Never a wide text button; see `docs/design/controls.md`.
 *
 * Designed in `docs/design/first-run-setup/`.
 */

import { useState } from "react";
import { IconCheck, IconMark } from "../components/Icons.js";
import { loadSettings, signInMethods } from "../lib/settings.js";
import { completeSetup } from "../lib/setup.js";
import { KeepIt } from "./setup/KeepIt.js";
import { WaysIn } from "./setup/WaysIn.js";
import "./setup.css";

export const setupScreenDependencies = {
  completeSetup,
  loadSettings,
};

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [finishing, setFinishing] = useState(false);

  const verb = finishing ? "Saving…" : "Finish setup";

  function finish() {
    // The answer already lives in `settings.v1` — the ways-in list writes
    // there as it is edited, because the sign-in screen reads that same list.
    // The record only says which roads were taken, so a later screen can tell
    // "nobody set this up" from "the operator deliberately runs it this way".
    const settings = setupScreenDependencies.loadSettings();
    const methods = signInMethods(settings);
    setFinishing(true);
    void setupScreenDependencies
      .completeSetup({
        ways: [
          ...(methods.builtin ? ["builtin"] : []),
          ...methods.providers.map((idp) => idp.providerId || "oidc"),
        ],
        service: Boolean(settings.identityApi.trim()),
      })
      .catch(() => {
        // The record is a convenience, not a gate: a browser that cannot
        // persist it will ask again next time, which the unlock screen already
        // warns about. Never trap the operator on the last step for it.
      })
      .finally(onDone);
  }

  return (
    <div className="setup">
      <div className="setup__frame">
        <div className="setup__bar">
          <p className="setup__wordmark">
            <IconMark size={16} />
            opensesame
          </p>
        </div>

        <main className="setup__body" id="main">
          <div className="setup__head">
            <h1>How do people sign in?</h1>
            <p>
              You are the first person here, so you are the operator. This is
              the only question — and it already has a working answer. Add as
              many ways in as you like; the sign-in screen offers exactly these.
            </p>
          </div>

          <WaysIn />

          {/* Not a second question — an offer with no wrong answer, below the
              one that matters and withheld entirely where the browser will not
              install. ADR 0085. */}
          <KeepIt />
        </main>

        {/* The terminal commit: an ink square with the glyph of what it does,
            its sentence beside it. `docs/design/controls.md`. */}
        <div className="setup__foot">
          <div className="go-row">
            <button
              type="button"
              className="go"
              disabled={finishing}
              aria-busy={finishing}
              aria-label={verb}
              title={verb}
              onClick={finish}
            >
              <IconCheck size={18} />
            </button>
            <span className="go-verb" aria-hidden="true">
              {verb}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
