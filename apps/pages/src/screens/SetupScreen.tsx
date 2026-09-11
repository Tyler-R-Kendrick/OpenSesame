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
 * The operator road is a tab per concern (ADR 0114): backups, ai, identity,
 * mfa, sync. Every tab writes `settings.v1` as it is answered, every tab is
 * skippable, and "Skip all" takes the whole tour off the table — skipping is
 * recorded, so "looked and passed" stays distinct from "never looked". The
 * terminal commit is the shared `.go` control. The join road is a claim
 * invite (ADR 0079 §7) or a request into a public session, and is the only
 * place the Host is asked for, because sharing is the action that
 * reintroduces the server.
 *
 * Designed in `docs/design/first-run-setup/` and `docs/design/shared-sessions/`.
 */

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconChevronLeft } from "../components/Icons.js";
import { Wordmark } from "../components/Wordmark.js";
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
import { AiStep } from "./setup/steps/AiStep.js";
import { BackupsStep } from "./setup/steps/BackupsStep.js";
import { IdentityStep } from "./setup/steps/IdentityStep.js";
import { MfaStep } from "./setup/steps/MfaStep.js";
import { SyncStep } from "./setup/steps/SyncStep.js";
import "./setup.css";

export const setupScreenDependencies = {
  completeSetup,
  loadSettings,
  readJoinFromLocation,
};

export type SetupRoad = "setup" | "join";

const STEPS = [
  { id: "backups", tab: "backups", rail: "Backups", Panel: BackupsStep },
  { id: "ai", tab: "ai", rail: "AI", Panel: AiStep },
  { id: "identity", tab: "identity", rail: "Identity", Panel: IdentityStep },
  { id: "mfa", tab: "mfa", rail: "MFA", Panel: MfaStep },
  { id: "sync", tab: "sync", rail: "Sync", Panel: SyncStep },
] as const;

/** A tab of the operator ceremony (ADR 0114). */
export type SetupStep = (typeof STEPS)[number]["id"];

function initialInvite(): ParsedInvite | null {
  return setupScreenDependencies.readJoinFromLocation();
}

export function SetupScreen({
  onDone,
  road,
  step,
}: {
  /** Back to the sign-in screen — after finishing, or by backing out. */
  onDone: () => void;
  /**
   * Which ceremony to open. Absent, an invite in the address bar opens join;
   * otherwise the operator question.
   */
  road?: SetupRoad;
  /**
   * The tab to open on — a road that knows its concern (the no-way-in notice)
   * lands on it directly; anything else takes the tour from the top.
   */
  step?: SetupStep;
}) {
  useSupportRoute("/setup");
  const finishRef = useGuideTarget<HTMLButtonElement>("setup.finish");
  const [invite] = useState<ParsedInvite | null>(initialInvite);
  const [finishing, setFinishing] = useState(false);
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      STEPS.findIndex((entry) => entry.id === step),
    ),
  );
  const [skipped, setSkipped] = useState<SetupStep[]>([]);
  const active: SetupRoad = road ?? (invite ? "join" : "setup");
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrubJoinHash();
  }, []);

  // Each road lands the keyboard where its answer is — the invite on join,
  // and on setup the terminal commit: nothing here is required, so Enter
  // finishes, and Shift+Tab walks back up into the tabs. The first control
  // in a step's body can be a Remove, which an arrival must not land on.
  useEffect(() => {
    if (active === "setup") {
      landFocus(frameRef.current?.querySelector(".go"));
      return;
    }
    landFocus(firstControl(frameRef.current?.querySelector("main")));
  }, [active]);

  const verb = finishing ? "Saving…" : "Finish setup";

  function finish(skippedSteps: readonly SetupStep[]) {
    // The answers already live in `settings.v1` — every step writes there as
    // it is touched, because the screens that read them do too. The record
    // only says which roads were taken and which were stepped past, so a
    // later screen can tell "nobody set this up" from "the operator
    // deliberately runs it this way".
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
        skipped: [...skippedSteps],
      })
      .catch(() => {
        // The record is a convenience, not a gate: a browser that cannot
        // persist it will ask again next time, which the unlock screen already
        // warns about. Never trap the operator on the last step for it.
      })
      .finally(onDone);
  }

  function skipStep() {
    const current = STEPS[index];
    if (!current) return;
    const next = [...skipped, current.id];
    setSkipped(next);
    if (index + 1 < STEPS.length) setIndex(index + 1);
    else finish(next);
  }

  function skipAll() {
    finish([...skipped, ...STEPS.slice(index).map((step) => step.id)]);
  }

  const current = STEPS[index] ?? STEPS[0];

  return (
    <div className="setup">
      <div className="setup__frame" ref={frameRef}>
        <div className="setup__bar">
          <Wordmark className="setup__wordmark" />
          {/* Backing out changes nothing: every step writes to settings as it
              is answered, and nothing here was ever required. */}
          <button type="button" className="setup__back" onClick={onDone}>
            <IconChevronLeft size={16} />
            Back
          </button>
          <button
            type="button"
            className="setup__back setup__skipall"
            disabled={finishing}
            onClick={skipAll}
          >
            Skip all
          </button>
        </div>

        {active === "join" ? (
          <JoinSession initial={invite} onDone={onDone} />
        ) : (
          <>
            <main className="setup__body" id="main">
              <div className="steps" aria-label="Setup steps">
                {STEPS.map((entry, at) => (
                  <div
                    key={entry.id}
                    className={`steps__seg${
                      at < index ? " is-done" : at === index ? " is-now" : ""
                    }`}
                  >
                    <span className="steps__bar" />
                    <span className="steps__label">{`${at + 1} · ${entry.rail}`}</span>
                  </div>
                ))}
              </div>

              <div
                className="setup__tabs"
                role="tablist"
                aria-label="Setup step"
              >
                {STEPS.map((entry, at) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={at === index}
                    className={`setup__tab${
                      at === index ? " setup__tab--active" : ""
                    }`}
                    onClick={() => setIndex(at)}
                  >
                    {entry.tab}
                  </button>
                ))}
              </div>

              <current.Panel />

              {/* Not a question — an offer with no wrong answer, below the
                  step that is on screen and withheld entirely where the
                  browser will not install. ADR 0086. */}
              <GuideTarget id="setup.keep">
                <KeepIt />
              </GuideTarget>
            </main>

            <div className="setup__foot">
              <button
                type="button"
                className="setup__back"
                disabled={finishing}
                onClick={skipStep}
              >
                Skip this step
              </button>
              <div className="go-row">
                <button
                  ref={finishRef}
                  type="button"
                  className="go"
                  disabled={finishing}
                  aria-busy={finishing}
                  aria-label={verb}
                  title={verb}
                  onClick={() => finish(skipped)}
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
