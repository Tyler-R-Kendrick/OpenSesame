/**
 * Deployment setup and joining a session — two optional ceremonies.
 *
 * Neither is a gate. This static app is complete without a backend (ADR
 * 0090): a first visitor signs in through the compiled-in broker, continues
 * as a guest, or seals a local vault, and never has to answer an operator's
 * question first. This screen is reached on purpose — `Deployment setup` or
 * `Join a session` from the sign-in screen's foot — or by arriving on an
 * invite link, which opens the join road directly because the link *is* the
 * request.
 *
 * The operator road is still one question: who signs people in. No stepper,
 * no counter. The terminal commit is the shared `.go` control. The join road
 * is a claim invite (ADR 0079 §7) or a request into a public session, and is
 * the only place the Host is asked for, because sharing is the action that
 * reintroduces the server.
 *
 * Designed in `docs/design/first-run-setup/` and `docs/design/shared-sessions/`.
 */

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconChevronLeft, IconMark } from "../components/Icons.js";
import { firstControl, landFocus } from "../lib/focus.js";
import {
  type ParsedInvite,
  readJoinFromLocation,
  scrubJoinHash,
} from "../lib/join-session.js";
import { loadSettings, signInMethods } from "../lib/settings.js";
import { completeSetup } from "../lib/setup.js";
import { GuideTarget, useGuideTarget } from "../tutorial/registry/react.jsx";
import { useSupportRoute } from "../tutorial/session.js";
import { JoinSession } from "./setup/JoinSession.js";
import { KeepIt } from "./setup/KeepIt.js";
import { WaysIn } from "./setup/WaysIn.js";
import "./setup.css";

export const setupScreenDependencies = {
  completeSetup,
  loadSettings,
  readJoinFromLocation,
};

export type SetupRoad = "setup" | "join";

function initialInvite(): ParsedInvite | null {
  return setupScreenDependencies.readJoinFromLocation();
}

export function SetupScreen({
  onDone,
  road,
}: {
  /** Back to the sign-in screen — after finishing, or by backing out. */
  onDone: () => void;
  /**
   * Which ceremony to open. Absent, an invite in the address bar opens join;
   * otherwise the operator question.
   */
  road?: SetupRoad;
}) {
  useSupportRoute("/setup");
  const finishRef = useGuideTarget<HTMLButtonElement>("setup.finish");
  const [invite] = useState<ParsedInvite | null>(initialInvite);
  const [finishing, setFinishing] = useState(false);
  const active: SetupRoad = road ?? (invite ? "join" : "setup");
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrubJoinHash();
  }, []);

  // Each road lands the keyboard where its answer is — the invite on join,
  // and on setup the terminal commit: the compiled-in broker is already a way
  // in, so Enter finishes, and Shift+Tab walks back up into the list. The
  // first control in setup's body is a provider's Remove, which is the one
  // thing an arrival must not land on.
  useEffect(() => {
    if (active === "setup") {
      landFocus(frameRef.current?.querySelector(".go"));
      return;
    }
    landFocus(firstControl(frameRef.current?.querySelector("main")));
  }, [active]);

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
      <div className="setup__frame" ref={frameRef}>
        <div className="setup__bar">
          <p className="setup__wordmark">
            <IconMark size={16} />
            opensesame
          </p>
          {/* Backing out changes nothing: the ways-in list writes to settings
              as it is edited, and nothing here was ever required. */}
          <button type="button" className="setup__back" onClick={onDone}>
            <IconChevronLeft size={16} />
            Back
          </button>
        </div>

        {active === "join" ? (
          <JoinSession initial={invite} onDone={onDone} />
        ) : (
          <>
            <main className="setup__body" id="main">
              <div className="setup__head">
                <h1>How do people sign in?</h1>
              </div>

              <GuideTarget id="setup.ways">
                <WaysIn />
              </GuideTarget>

              {/* Not a second question — an offer with no wrong answer, below
                  the one that matters and withheld entirely where the browser
                  will not install. ADR 0086. */}
              <GuideTarget id="setup.keep">
                <KeepIt />
              </GuideTarget>
            </main>

            <div className="setup__foot">
              <div className="go-row">
                <button
                  ref={finishRef}
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
          </>
        )}
      </div>
    </div>
  );
}
