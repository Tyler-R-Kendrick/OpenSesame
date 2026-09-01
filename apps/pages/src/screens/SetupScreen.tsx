/**
 * The first-run ceremony — set this device up, or join a session.
 *
 * A device with no vault and no session has two honest roads. Treating every
 * first visitor as the operator (ADR 0077) left people who had been invited
 * answering "how do people sign in?" for a deployment they do not run. Join
 * is the other road: a claim invite (ADR 0079 §7) or a request into a public
 * session. The Host is asked for only on that road, because sharing is the
 * action that reintroduces the server.
 *
 * The operator road is still one question: who signs people in. No stepper,
 * no counter, no skip. The terminal commit is the shared `.go` control.
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

type Road = "choice" | "setup" | "join";

function initialRoad(): Road {
  return setupScreenDependencies.readJoinFromLocation() ? "join" : "choice";
}

function initialInvite(): ParsedInvite | null {
  return setupScreenDependencies.readJoinFromLocation();
}

export function SetupScreen({
  onDone,
  intent,
}: {
  onDone: () => void;
  /** Skip the fork when a vault or session already exists and setup was asked for. */
  intent?: Road;
}) {
  useSupportRoute("/setup");
  const finishRef = useGuideTarget<HTMLButtonElement>("setup.finish");
  const [road, setRoad] = useState<Road>(intent ?? initialRoad);
  const [invite] = useState<ParsedInvite | null>(initialInvite);
  const [finishing, setFinishing] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrubJoinHash();
  }, []);

  // Each road lands the keyboard where its answer is — the first road on the
  // choice, the invite on join, and on setup the terminal commit: the
  // compiled-in broker is already a way in, so Enter finishes, and Shift+Tab
  // walks back up into the list. The first control in setup's body is a
  // provider's Remove, which is the one thing an arrival must not land on.
  useEffect(() => {
    if (road === "setup") {
      landFocus(frameRef.current?.querySelector(".go"));
      return;
    }
    landFocus(firstControl(frameRef.current?.querySelector("main")));
  }, [road]);

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
          {road === "choice" ? (
            <p className="setup__wordmark">
              <IconMark size={16} />
              opensesame
            </p>
          ) : (
            <button
              type="button"
              className="setup__back"
              onClick={() => setRoad("choice")}
            >
              <IconChevronLeft size={16} />
              Back
            </button>
          )}
        </div>

        {road === "join" ? (
          <JoinSession initial={invite} onDone={onDone} />
        ) : road === "setup" ? (
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
        ) : (
          <main className="setup__body" id="main">
            <div className="setup__head">
              <h1>This device is empty</h1>
            </div>

            <div className="roads">
              <GuideTarget id="setup.choose">
                <button
                  type="button"
                  className="preset__opt"
                  onClick={() => setRoad("setup")}
                >
                  <span className="preset__name">Set up this device</span>
                  <span className="preset__kind">
                    Choose who signs people in
                  </span>
                </button>
              </GuideTarget>
              <GuideTarget id="setup.join">
                <button
                  type="button"
                  className="preset__opt"
                  onClick={() => setRoad("join")}
                >
                  <span className="preset__name">Join a session</span>
                  <span className="preset__kind">A link and a code</span>
                </button>
              </GuideTarget>
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
