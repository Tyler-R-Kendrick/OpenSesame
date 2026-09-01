/**
 * The install offer — one card, two homes.
 *
 * It appears as the last section of the first-run ceremony (`screens/setup/
 * KeepIt.tsx`) and in Settings → General for good (`sections/settings/
 * InstallPanel.tsx`). Same component in both, because they are the same offer:
 * duplicating it is how the ceremony and the settings panel end up disagreeing
 * about what installing does.
 *
 * The shape follows `docs/design/controls.md`: what the browser told us is a
 * discovery, so it wears the `.found` card, and the action lives *inside* that
 * card as a `.btn--primary` beside the facts that justify it — never as the
 * screen's terminal commit, which belongs to the ceremony.
 *
 * Drawn in `docs/design/pwa-install/`.
 */

import { briefOrigin } from "@opensesame/os-domain";
import { useEffect, useState } from "react";
import { ensurePersistence as ensurePersistenceDefault } from "../lib/install.js";
import { pagesPublicBase } from "../lib/site-broker.js";
import { useInstall } from "../lib/use-install.js";
import { IconAddSquare, IconCheck, IconDownload, IconShare } from "./Icons.js";

export const installOfferDependencies = {
  ensurePersistence: ensurePersistenceDefault,
};

/**
 * What installing actually buys, per state.
 *
 * The vault is stored on this device, and a browser may clear a tab's storage
 * when the device runs short of room. That is the claim, it is this app's own
 * reason rather than a generic "launch faster", and the effect below asks for
 * persistent storage whenever the app observes itself installed — not only on
 * the one road that goes through our own button — so the claim holds however
 * the install happened.
 */
/** The deployment this app was served from, as it will read in the card. */
function servedFrom(): string {
  if (globalThis.window === undefined) return "";
  // `apps/pages` deploys under a base path (`/OpenSesame/` by default), and
  // that path — not the bare host — is what the installed app's scope covers.
  // Two deployments on one GitHub Pages account differ only by it. Through the
  // app's own helper rather than a sixth hand-rolled `BASE_URL` trim, so the
  // card can never name a path the service worker does not scope.
  return briefOrigin(pagesPublicBase());
}

export function InstallOffer({ heading }: { heading?: string } = {}) {
  const { state, visible, persisted, install } = useInstall();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");

  useEffect(() => {
    // Whenever the app finds itself installed, however it got there — our own
    // button, Chromium's address-bar icon, iOS Add to Home Screen, or a later
    // launch. `ensurePersistence` asks at most once per load and only once the
    // browser itself confirms the install, so this is usually a no-op; the
    // answer arrives through the store, not through here.
    if (state !== "installed") return;
    void installOfferDependencies.ensurePersistence();
  }, [state]);

  // Withheld, not explained away. A card that exists only to say the browser
  // cannot do this is the amber notice ADR 0077 deleted, in a friendlier hat.
  // The heading goes with it, so a host cannot leave one standing over
  // nothing by forgetting a guard of its own (ADR 0086 §2).
  if (!visible) return null;

  const body = (
    <div className="keep">
      {state === "prompt" ? (
        <div className="found">
          <p className="found__top">
            <IconDownload size={14} />
            This browser can install it
          </p>
          <p className="found__name">OpenSesame</p>
          <dl>
            <dt>From</dt>
            <dd>{servedFrom()}</dd>
            <dt>Opens</dt>
            <dd>its own window, offline</dd>
            <dt>Needs</dt>
            <dd>no store, no account</dd>
          </dl>
          <div className="found__do">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              aria-busy={busy}
              onClick={() => {
                // The dialog must open inside this gesture; `promptInstall`
                // awaits the reader's answer, not a round trip, so nothing
                // here defers the call past the activation.
                setBusy(true);
                void install()
                  .then((outcome) => {
                    // `retry` is the browser refusing to trace the gesture,
                    // not the reader refusing the install: the event was never
                    // consumed and the button is still live beside them, so
                    // sending them off to a browser menu would be wrong. Say
                    // nothing and let them press again.
                    if (outcome === "retry") return;
                    setSaid(
                      outcome === "accepted"
                        ? "OpenSesame installed."
                        : "Not installed. You can install it from the browser's own menu.",
                    );
                  })
                  .catch(() => {
                    // The seam is a public override and nothing enforces that
                    // it never rejects. An unspoken outcome plus an unhandled
                    // rejection is worse than a plain failure.
                    setSaid("The browser could not open the install dialog.");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Waiting for the browser…" : "Install OpenSesame"}
            </button>
          </div>
        </div>
      ) : null}

      {state === "manual" ? (
        // No API exists on iOS, so the road is the reader's own three taps —
        // in the OS's own words, with the glyphs they are looking for drawn
        // inline rather than named.
        // biome-ignore lint/a11y/useSemanticElements: this IS the semantic element — the role is the WebKit workaround below
        // biome-ignore lint/a11y/noRedundantRoles: redundant by spec, load-bearing in Safari — `list-style: none` (styles.css `.keep__steps`) makes WebKit drop the list role, and this branch renders on WebKit only
        <ol className="keep__steps" role="list">
          <li className="keep__step">
            <span className="keep__num" aria-hidden="true">
              1
            </span>
            <span>
              Tap{" "}
              <span className="keep__glyph">
                <IconShare size={15} />
              </span>{" "}
              Share, in your browser's toolbar.
            </span>
          </li>
          <li className="keep__step">
            <span className="keep__num" aria-hidden="true">
              2
            </span>
            <span>
              Scroll to{" "}
              <span className="keep__glyph">
                <IconAddSquare size={15} />
              </span>{" "}
              <strong>Add to Home Screen</strong>.
            </span>
          </li>
          <li className="keep__step">
            <span className="keep__num" aria-hidden="true">
              3
            </span>
            <span>
              Tap <strong>Add</strong>.
            </span>
          </li>
        </ol>
      ) : null}

      {state === "dismissed" ? (
        <p className="found__top">Install from the browser menu</p>
      ) : null}

      {state === "installed" ? (
        // It reports and offers nothing: an install button beside an installed
        // app is a control with nothing left to do.
        <div className="found found--done">
          <p className="found__top">
            <IconCheck size={14} />
            Installed
          </p>
          <p className="found__name">OpenSesame</p>
          <dl>
            <dt>Storage</dt>
            <dd>
              {persisted
                ? "kept — this device agreed to hold it"
                : "on this device"}
            </dd>
          </dl>
        </div>
      ) : null}

      {/* The card is replaced wholesale when the outcome lands, so without
          this the dialog's answer is never spoken and focus is already on
          <body>. Same shape as `components/FieldRow.tsx`. */}
      <span className="visually-hidden" aria-live="polite">
        {said}
      </span>
    </div>
  );

  // Without a heading this IS the card; with one it is a titled section, and
  // the title is withheld with the body so no host can strand it.
  if (!heading) return body;
  return (
    <div className="setup__stack">
      <p className="ways__head">{heading}</p>
      {body}
    </div>
  );
}
